//! The microphones and speakers this computer has, and which of them a
//! choice means now.

use serde::Serialize;

use super::prefs::DeviceChoice;

/// One microphone or speaker. `id` is the system's stable id for it: Core
/// Audio's UID on macOS, cpal's device id elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// The one the system uses now.
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Devices {
    pub inputs: Vec<Device>,
    pub outputs: Vec<Device>,
}

impl Devices {
    /// The microphone `choice` means now ([`resolve`]).
    pub fn input(&self, choice: Option<&DeviceChoice>) -> Resolved {
        resolve(&self.inputs, choice)
    }

    pub fn output(&self, choice: Option<&DeviceChoice>) -> Resolved {
        resolve(&self.outputs, choice)
    }
}

/// What a choice comes to among the devices there are now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// The chosen device, by the id it has now.
    Chosen(Device),
    /// The system's: nothing chosen, or the chosen one isn't here. `None`
    /// when the system has no default either.
    System(Option<Device>),
}

impl Resolved {
    /// The device id to open; `None` is the system's own, followed by the
    /// platform as it changes.
    pub fn id(&self) -> Option<&str> {
        match self {
            Resolved::Chosen(d) => Some(&d.id),
            Resolved::System(_) => None,
        }
    }

    /// The device this is, whichever way it was reached.
    pub fn device(&self) -> Option<&Device> {
        match self {
            Resolved::Chosen(d) => Some(d),
            Resolved::System(d) => d.as_ref(),
        }
    }

    /// Whether the person's choice is away and the system's is used meanwhile.
    pub fn missing(&self, choice: Option<&DeviceChoice>) -> bool {
        choice.is_some() && matches!(self, Resolved::System(_))
    }
}

/// `choice` among `devices`: by its id, else by its name (an id that changed
/// when the device was plugged in again), else the system's default.
pub fn resolve(devices: &[Device], choice: Option<&DeviceChoice>) -> Resolved {
    let chosen = choice.and_then(|c| {
        devices
            .iter()
            .find(|d| d.id == c.id)
            .or_else(|| devices.iter().find(|d| d.name == c.name))
    });
    match chosen {
        Some(d) => Resolved::Chosen(d.clone()),
        None => Resolved::System(devices.iter().find(|d| d.is_default).cloned()),
    }
}

/// The devices there are now.
pub fn list() -> Devices {
    super::platform::devices()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, name: &str, is_default: bool) -> Device {
        Device {
            id: id.into(),
            name: name.into(),
            is_default,
        }
    }

    fn choice(id: &str, name: &str) -> DeviceChoice {
        DeviceChoice {
            id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn a_choice_is_found_by_id_then_by_name_else_the_system_default_is_used() {
        let mics = [
            device("display", "LG UltraFine Display Audio", true),
            device("yeti-1", "Yeti Stereo Microphone", false),
        ];
        assert_eq!(
            resolve(&mics, None),
            Resolved::System(Some(mics[0].clone()))
        );
        assert_eq!(
            resolve(&mics, Some(&choice("yeti-1", "Yeti Stereo Microphone"))),
            Resolved::Chosen(mics[1].clone())
        );
        // Plugged into another port: a new id, the same name.
        assert_eq!(
            resolve(&mics, Some(&choice("yeti-2", "Yeti Stereo Microphone"))),
            Resolved::Chosen(mics[1].clone())
        );
        // Unplugged: the system's, until it comes back.
        let away = choice("airpods", "AirPods Pro");
        let r = resolve(&mics, Some(&away));
        assert_eq!(r, Resolved::System(Some(mics[0].clone())));
        assert!(r.missing(Some(&away)));
        assert_eq!(r.id(), None);
        assert!(!resolve(&mics, None).missing(None));
    }

    #[test]
    fn the_id_wins_over_another_device_with_the_same_name() {
        let mics = [
            device("a", "USB Microphone", false),
            device("b", "USB Microphone", true),
        ];
        assert_eq!(
            resolve(&mics, Some(&choice("b", "USB Microphone"))).id(),
            Some("b")
        );
    }

    #[test]
    fn no_devices_at_all_is_the_system_with_none() {
        assert_eq!(resolve(&[], None), Resolved::System(None));
        assert_eq!(resolve(&[], None).device(), None);
    }
}
