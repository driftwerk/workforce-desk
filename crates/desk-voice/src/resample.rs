//! Microphone audio to what the speech models take: mono, 16 kHz, f32.

use std::f64::consts::PI;

pub const SPEECH_RATE: u32 = 16_000;

/// The mean of the channels, frame by frame.
pub fn downmix(channels: &[&[f32]]) -> Vec<f32> {
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let scale = 1.0 / channels.len().max(1) as f32;
    (0..frames)
        .map(|i| channels.iter().map(|c| c[i]).sum::<f32>() * scale)
        .collect()
}

/// A streaming band-limited resampler: windowed-sinc interpolation with the
/// cutoff below the lower of the two Nyquist rates, so downsampling doesn't
/// alias. Chunk boundaries don't matter; state carries across calls.
pub struct Resampler {
    from: u32,
    to: u32,
    cutoff: f64,
    taps: usize,
    history: Vec<f32>,
    history_start: u64,
    produced: u64,
}

const TAPS_PER_SIDE: usize = 24;

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let cutoff = 0.92 * (f64::from(to) / f64::from(from)).min(1.0);
        let taps = (TAPS_PER_SIDE as f64 / cutoff).ceil() as usize;
        Self {
            from,
            to,
            cutoff,
            taps,
            history: vec![0.0; taps],
            history_start: 0,
            produced: 0,
        }
    }

    pub fn from_rate(&self) -> u32 {
        self.from
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.from == self.to {
            return input.to_vec();
        }
        self.history.extend_from_slice(input);
        let ratio = f64::from(self.from) / f64::from(self.to);
        let mut out = Vec::with_capacity((input.len() as f64 / ratio) as usize + 1);
        loop {
            let t = self.produced as f64 * ratio + self.taps as f64;
            let centre = t.floor() as u64;
            let last_needed = centre + self.taps as u64;
            if last_needed >= self.history_start + self.history.len() as u64 {
                break;
            }
            out.push(self.sample_at(t));
            self.produced += 1;
        }
        let keep_from = (self.produced as f64 * ratio).floor() as u64;
        if keep_from > self.history_start {
            let drop = ((keep_from - self.history_start) as usize).min(self.history.len());
            self.history.drain(..drop);
            self.history_start += drop as u64;
        }
        out
    }

    /// The signal at fractional input position `t` (in padded input samples).
    fn sample_at(&self, t: f64) -> f32 {
        let centre = t.floor() as i64;
        let half = self.taps as i64;
        let mut acc = 0.0;
        for k in (centre - half + 1)..=(centre + half) {
            let x = self.history[(k - self.history_start as i64) as usize];
            acc += f64::from(x) * self.kernel(t - k as f64);
        }
        acc as f32
    }

    fn kernel(&self, d: f64) -> f64 {
        let half = self.taps as f64;
        if d.abs() >= half {
            return 0.0;
        }
        let x = self.cutoff * d;
        let sinc = if x.abs() < 1e-9 {
            1.0
        } else {
            (PI * x).sin() / (PI * x)
        };
        let w = 0.42 + 0.5 * (PI * d / half).cos() + 0.08 * (2.0 * PI * d / half).cos();
        self.cutoff * sinc * w
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        (0..n)
            .map(|i| (2.0 * PI * freq * i as f64 / f64::from(rate)).sin() as f32)
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    fn crossings(x: &[f32]) -> usize {
        x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
    }

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(
            downmix(&[&[1.0, 0.0, 0.5], &[0.0, 0.0, 0.5]]),
            [0.5, 0.0, 0.5]
        );
        assert_eq!(downmix(&[&[0.25, 0.75]]), [0.25, 0.75]);
        assert!(downmix(&[]).is_empty());
    }

    #[test]
    fn keeps_a_tone_in_the_speech_band() {
        for rate in [48_000, 44_100, 24_000] {
            let out = Resampler::new(rate, SPEECH_RATE).process(&tone(1_000.0, rate, 1.0));
            assert!(
                (out.len() as i64 - 16_000).abs() < 60,
                "{rate}: {} samples",
                out.len()
            );
            let body = &out[400..out.len() - 400];
            assert!(
                (rms(body) - 0.5f64.sqrt()).abs() < 0.01,
                "{rate}: rms {}",
                rms(body)
            );
            let hz = crossings(body) as f64 * 16_000.0 / body.len() as f64;
            assert!((hz - 1_000.0).abs() < 5.0, "{rate}: {hz} Hz");
        }
    }

    #[test]
    fn removes_what_16k_cannot_carry() {
        let out = Resampler::new(48_000, SPEECH_RATE).process(&tone(12_000.0, 48_000, 0.5));
        assert!(rms(&out[200..out.len() - 200]) < 0.01);
    }

    #[test]
    fn chunking_does_not_change_the_output() {
        let input = tone(440.0, 44_100, 0.3);
        let whole = Resampler::new(44_100, SPEECH_RATE).process(&input);
        let mut r = Resampler::new(44_100, SPEECH_RATE);
        let chunked: Vec<f32> = input.chunks(333).flat_map(|c| r.process(c)).collect();
        assert_eq!(whole.len(), chunked.len());
        assert!(
            whole
                .iter()
                .zip(&chunked)
                .all(|(a, b)| (a - b).abs() < 1e-6)
        );
    }

    #[test]
    fn passes_through_at_the_same_rate() {
        let input = tone(300.0, SPEECH_RATE, 0.01);
        assert_eq!(
            Resampler::new(SPEECH_RATE, SPEECH_RATE).process(&input),
            input
        );
    }

    #[test]
    fn upsamples_without_changing_pitch() {
        let out = Resampler::new(8_000, SPEECH_RATE).process(&tone(500.0, 8_000, 1.0));
        let body = &out[400..out.len() - 400];
        let hz = crossings(body) as f64 * 16_000.0 / body.len() as f64;
        assert!((hz - 500.0).abs() < 5.0, "{hz} Hz");
    }
}
