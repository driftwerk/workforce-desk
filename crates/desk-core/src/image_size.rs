//! How big a picture is once decoded, read from its headers alone: a small
//! file can declare a picture of billions of pixels (a decompression bomb),
//! or an animation of thousands of frames, and the page would decode it.
//!
//! Each reader walks only the headers it needs, bounds-checked; a file whose
//! size can't be read this way is refused by the caller.

/// A picture's size: its largest frame's sides, and how many frames it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

impl Size {
    fn still(width: u32, height: u32) -> Size {
        Size {
            width,
            height,
            frames: 1,
        }
    }
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn le24(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 3)?;
    Some(s[0] as u32 | (s[1] as u32) << 8 | (s[2] as u32) << 16)
}
fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The size of a picture of type `mime` (as `sniff` named it).
pub fn read(mime: &str, b: &[u8]) -> Option<Size> {
    match mime {
        "image/png" => png(b),
        "image/jpeg" => jpeg(b),
        "image/gif" => gif(b),
        "image/webp" => webp(b),
        "image/avif" => avif(b),
        _ => None,
    }
}

/// IHDR, then an APNG's frame count from `acTL` if it has one before IDAT.
fn png(b: &[u8]) -> Option<Size> {
    if b.get(12..16)? != b"IHDR" {
        return None;
    }
    let mut size = Size::still(be32(b, 16)?, be32(b, 20)?);
    let mut at = 8;
    while let (Some(len), Some(kind)) = (be32(b, at), b.get(at + 4..at + 8)) {
        match kind {
            b"acTL" => {
                size.frames = be32(b, at + 8)?.max(1);
                break;
            }
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        at = at.checked_add(12)?.checked_add(len as usize)?;
    }
    Some(size)
}

/// The first start-of-frame segment's sides.
fn jpeg(b: &[u8]) -> Option<Size> {
    let mut at = 2;
    loop {
        if *b.get(at)? != 0xFF {
            return None;
        }
        // Fill bytes before a marker.
        while *b.get(at + 1)? == 0xFF {
            at += 1;
        }
        let marker = *b.get(at + 1)?;
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => at += 2,
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Some(Size::still(be16(b, at + 7)?, be16(b, at + 5)?));
            }
            0xD9 | 0xDA => return None,
            _ => at = at.checked_add(2)?.checked_add(be16(b, at + 2)? as usize)?,
        }
    }
}

/// The screen, and every image in the stream counted as a frame (the
/// largest one's sides if one is bigger than the screen).
fn gif(b: &[u8]) -> Option<Size> {
    let (mut width, mut height) = (le16(b, 6)?, le16(b, 8)?);
    let packed = *b.get(10)?;
    let mut at = 13;
    if packed & 0x80 != 0 {
        at += 3 << ((packed & 7) + 1);
    }
    let mut frames = 0u32;
    // Sub-blocks: a length byte, that many bytes, until a zero length.
    let skip_blocks = |mut at: usize| -> Option<usize> {
        loop {
            let n = *b.get(at)? as usize;
            at += 1 + n;
            if n == 0 {
                return Some(at);
            }
        }
    };
    loop {
        match b.get(at) {
            Some(0x2C) => {
                width = width.max(le16(b, at + 5)?);
                height = height.max(le16(b, at + 7)?);
                let local = *b.get(at + 9)?;
                at += 10;
                if local & 0x80 != 0 {
                    at += 3 << ((local & 7) + 1);
                }
                frames += 1;
                // The LZW code size, then the data.
                match skip_blocks(at + 1) {
                    Some(next) => at = next,
                    None => break,
                }
            }
            Some(0x21) => match skip_blocks(at + 2) {
                Some(next) => at = next,
                None => break,
            },
            // The trailer, a truncated file, or junk: what's counted stands.
            _ => break,
        }
    }
    Some(Size {
        width,
        height,
        frames: frames.max(1),
    })
}

/// The canvas from VP8X (or the one VP8 / VP8L frame), and each `ANMF` chunk
/// counted as a frame.
fn webp(b: &[u8]) -> Option<Size> {
    let mut at = 12;
    let mut size: Option<Size> = None;
    let mut frames = 0u32;
    while let (Some(kind), Some(len)) = (b.get(at..at + 4), le32(b, at + 4)) {
        let data = at + 8;
        match kind {
            b"VP8X" => size = Some(Size::still(le24(b, data + 4)? + 1, le24(b, data + 7)? + 1)),
            b"VP8 " if size.is_none() => {
                if b.get(data + 3..data + 6)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                size = Some(Size::still(
                    le16(b, data + 6)? & 0x3fff,
                    le16(b, data + 8)? & 0x3fff,
                ));
            }
            b"VP8L" if size.is_none() => {
                if *b.get(data)? != 0x2f {
                    return None;
                }
                let bits = le32(b, data + 1)?;
                size = Some(Size::still(
                    (bits & 0x3fff) + 1,
                    ((bits >> 14) & 0x3fff) + 1,
                ));
            }
            b"ANMF" => frames += 1,
            _ => {}
        }
        at = data
            .checked_add(len as usize)?
            .checked_add(len as usize & 1)?;
    }
    let mut size = size?;
    size.frames = frames.max(1);
    Some(size)
}

/// The largest `ispe` (image spatial extents) property: the whole picture
/// for a grid, the picture itself otherwise.
fn avif(b: &[u8]) -> Option<Size> {
    let mut best: Option<Size> = None;
    for at in b
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"ispe")
        .map(|(i, _)| i)
    {
        let (Some(w), Some(h)) = (be32(b, at + 8), be32(b, at + 12)) else {
            continue;
        };
        if best.is_none_or(|s| (w as u64) * (h as u64) > (s.width as u64) * (s.height as u64)) {
            best = Some(Size::still(w, h));
        }
    }
    best
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A PNG of `w`×`h`: the signature and IHDR (what's read), nothing else.
    pub(crate) fn png_of(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        b
    }

    /// A GIF of `w`×`h` with `frames` one-pixel images.
    pub(crate) fn gif_of(w: u16, h: u16, frames: usize) -> Vec<u8> {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 0, 0, 0]); // 2-colour table
        for _ in 0..frames {
            b.extend_from_slice(&[0x21, 0xF9, 4, 0, 10, 0, 0, 0]); // control
            b.extend_from_slice(&[0x2C, 0, 0, 0, 0]);
            b.extend_from_slice(&w.to_le_bytes());
            b.extend_from_slice(&h.to_le_bytes());
            b.extend_from_slice(&[0, 2, 2, 0x4C, 0x01, 0]);
        }
        b.push(0x3B);
        b
    }

    /// An animated WebP: a VP8X canvas of `w`×`h` and `frames` ANMF chunks.
    pub(crate) fn webp_of(w: u32, h: u32, frames: usize) -> Vec<u8> {
        let mut chunks = Vec::new();
        chunks.extend_from_slice(b"VP8X");
        chunks.extend_from_slice(&10u32.to_le_bytes());
        chunks.extend_from_slice(&[0x02, 0, 0, 0]);
        chunks.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
        chunks.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
        for _ in 0..frames {
            chunks.extend_from_slice(b"ANMF");
            chunks.extend_from_slice(&16u32.to_le_bytes());
            chunks.extend_from_slice(&[0; 16]);
        }
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&(4 + chunks.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WEBP");
        b.extend_from_slice(&chunks);
        b
    }

    #[test]
    fn png_and_apng() {
        assert_eq!(
            read("image/png", &png_of(640, 480)),
            Some(Size::still(640, 480))
        );
        let mut apng = png_of(100, 50);
        apng.extend_from_slice(&[0, 0, 0, 8]);
        apng.extend_from_slice(b"acTL");
        apng.extend_from_slice(&300u32.to_be_bytes());
        apng.extend_from_slice(&[0; 8]);
        assert_eq!(read("image/png", &apng).unwrap().frames, 300);
        assert_eq!(read("image/png", b"\x89PNG\r\n\x1a\n"), None);
    }

    #[test]
    fn jpeg_start_of_frame() {
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0];
        j.extend_from_slice(&[0xFF, 0xC2, 0, 11, 8, 0x01, 0xE0, 0x02, 0x80, 3]);
        assert_eq!(read("image/jpeg", &j), Some(Size::still(640, 480)));
        assert_eq!(read("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xDA]), None);
        assert_eq!(
            read("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xFF]),
            None
        );
    }

    #[test]
    fn gif_counts_its_frames() {
        assert_eq!(
            read("image/gif", &gif_of(320, 200, 1)),
            Some(Size::still(320, 200))
        );
        assert_eq!(
            read("image/gif", &gif_of(320, 200, 250)).unwrap().frames,
            250
        );
        let mut cut = gif_of(10, 10, 3);
        cut.truncate(cut.len() - 5);
        assert_eq!(read("image/gif", &cut).unwrap().frames, 3);
    }

    #[test]
    fn webp_canvas_and_frames() {
        assert_eq!(
            read("image/webp", &webp_of(1000, 800, 40)),
            Some(Size {
                width: 1000,
                height: 800,
                frames: 40
            })
        );
        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\x05\0\0\0\x2f".to_vec();
        lossless.extend_from_slice(&((99u32) | (49u32 << 14)).to_le_bytes());
        assert_eq!(read("image/webp", &lossless), Some(Size::still(100, 50)));
    }

    #[test]
    fn avif_largest_extent() {
        let mut a = b"\0\0\0\x1cftypavif".to_vec();
        for (w, h) in [(512u32, 512u32), (4096, 3072)] {
            a.extend_from_slice(&20u32.to_be_bytes());
            a.extend_from_slice(b"ispe\0\0\0\0");
            a.extend_from_slice(&w.to_be_bytes());
            a.extend_from_slice(&h.to_be_bytes());
        }
        assert_eq!(read("image/avif", &a), Some(Size::still(4096, 3072)));
        assert_eq!(read("image/avif", b"\0\0\0\x1cftypavif"), None);
    }
}
