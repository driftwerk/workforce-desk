//! Speech audio from cloud providers (MP3, or WAV) as mono f32 samples, so
//! it plays through the voice-processing output like on-device speech.

use std::io::Cursor;

use eyre::{Result, bail, eyre};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Mono speech at its own sample rate.
#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub samples: Vec<f32>,
    pub rate: u32,
}

/// Decodes a whole file. `content_type` (the response's `Content-Type`)
/// helps pick the format; the bytes decide.
pub fn decode(bytes: Vec<u8>, content_type: Option<&str>) -> Result<Audio> {
    let mut hint = Hint::new();
    if let Some(mime) = content_type.and_then(|c| c.split(';').next()) {
        hint.mime_type(mime.trim());
    }
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| eyre!("not audio Desk can play: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| eyre!("the audio has no sound track"))?;
    let id = track.id;
    let Some(CodecParameters::Audio(params)) = &track.codec_params else {
        bail!("the audio track has no codec");
    };
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())?;
    let mut samples = Vec::new();
    let mut frame = Vec::new();
    let mut rate = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id != id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        rate = buffer.spec().rate();
        let channels = buffer.spec().channels().count().max(1);
        frame.clear();
        buffer.copy_to_vec_interleaved(&mut frame);
        samples.extend(
            frame
                .chunks(channels)
                .map(|f| f.iter().sum::<f32>() / channels as f32),
        );
    }
    if rate == 0 || samples.is_empty() {
        bail!("the audio was empty");
    }
    Ok(Audio { samples, rate })
}

/// A 16-bit PCM WAV file, as a provider would send it.
#[cfg(test)]
pub(crate) fn wav(samples: &[f32], rate: u32, channels: u16) -> Vec<u8> {
    let data: Vec<u8> = samples
        .iter()
        .flat_map(|s| std::iter::repeat_n(*s, channels as usize))
        .flat_map(|s| ((s * f32::from(i16::MAX)) as i16).to_le_bytes())
        .collect();
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((36 + data.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(channels.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * u32::from(channels) * 2).to_le_bytes());
    out.extend((channels * 2).to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn tone(rate: u32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|i| (2.0 * PI * 440.0 * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn decodes_wav_and_downmixes_stereo() {
        let input = tone(24_000, 0.25);
        let audio = decode(wav(&input, 24_000, 2), Some("audio/wav")).unwrap();
        assert_eq!(audio.rate, 24_000);
        assert_eq!(audio.samples.len(), input.len());
        assert!(
            audio
                .samples
                .iter()
                .zip(&input)
                .all(|(a, b)| (a - b).abs() < 1e-3)
        );
    }

    /// `tests/fixtures/tone.mp3`: 0.5 s of 440 Hz at 24 kHz mono, as made by
    /// `ffmpeg -f lavfi -i sine=frequency=440:duration=0.5 -ar 24000 -ac 1 -b:a 32k`.
    #[test]
    fn decodes_mp3() {
        let bytes = include_bytes!("../tests/fixtures/tone.mp3").to_vec();
        let audio = decode(bytes, Some("audio/mpeg")).unwrap();
        assert_eq!(audio.rate, 24_000);
        let seconds = audio.samples.len() as f32 / audio.rate as f32;
        assert!((0.45..0.65).contains(&seconds), "{seconds} s");
        let body = &audio.samples[2_400..9_600];
        let crossings = body
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        let hz = crossings as f32 * audio.rate as f32 / body.len() as f32;
        assert!((hz - 440.0).abs() < 10.0, "{hz} Hz");
    }

    #[test]
    fn refuses_what_isnt_audio() {
        assert!(decode(br#"{"error":"no key"}"#.to_vec(), Some("application/json")).is_err());
        assert!(decode(Vec::new(), None).is_err());
    }
}
