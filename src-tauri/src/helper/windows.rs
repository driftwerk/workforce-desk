//! Desk Helper on Windows: until Desk runs its backend inside WSL, the
//! backend is a supervisor started by hand, as in development.

use desk_core::backend::Backend;
use eyre::Result;

use super::{Login, Status};

pub struct Helper;

impl Helper {
    pub fn new(_: Backend) -> Self {
        Helper
    }
}

impl Login for Helper {
    fn status(&self) -> Status {
        Status::Development
    }

    fn ensure(&self) -> Status {
        Status::Development
    }

    fn unregister(&self) -> Result<()> {
        Ok(())
    }

    fn open_settings(&self) {}
}
