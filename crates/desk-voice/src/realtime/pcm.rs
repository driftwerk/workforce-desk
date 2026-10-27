//! Audio as the realtime APIs carry it: mono 16-bit little-endian PCM,
//! base64 in JSON.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// f32 samples in [-1, 1] as PCM16 LE bytes, clipping anything louder.
pub fn encode(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16).to_le_bytes())
        .collect()
}

pub fn to_base64(samples: &[f32]) -> String {
    STANDARD.encode(encode(samples))
}

pub fn from_base64(data: &str) -> Option<Vec<u8>> {
    STANDARD.decode(data).ok()
}

/// PCM16 LE bytes back to f32 samples. A chunk may end mid-sample; the odd
/// byte waits for the next chunk.
#[derive(Default)]
pub struct Decoder {
    carry: Option<u8>,
}

impl Decoder {
    pub fn decode(&mut self, bytes: &[u8]) -> Vec<f32> {
        let mut joined = Vec::with_capacity(bytes.len() + 1);
        joined.extend(self.carry.take());
        joined.extend_from_slice(bytes);
        if joined.len() % 2 == 1 {
            self.carry = joined.pop();
        }
        joined
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| f32::from(i16::from_le_bytes(*b)) / f32::from(i16::MAX))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_little_endian_and_clips() {
        assert_eq!(
            encode(&[0.0, 1.0, -1.0, 2.0]),
            [0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]
        );
        assert_eq!(to_base64(&[0.0]), "AAA=");
    }

    #[test]
    fn decodes_what_it_encodes() {
        let samples = [0.5, -0.25, 0.0, 0.999];
        let back = Decoder::default().decode(&encode(&samples));
        assert!(samples.iter().zip(&back).all(|(a, b)| (a - b).abs() < 1e-4));
    }

    #[test]
    fn an_odd_byte_waits_for_the_next_chunk() {
        let bytes = encode(&[0.5, -0.5]);
        let mut d = Decoder::default();
        let first = d.decode(&bytes[..3]);
        let second = d.decode(&bytes[3..]);
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert!((second[0] + 0.5).abs() < 1e-4);
    }
}
