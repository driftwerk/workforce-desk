//! Changing the local Postgres's password once, on installs that had it
//! somewhere readable.
//!
//! Before an earlier Desk, the password sat in `hub/.pgpass` (mode 0644)
//! from install until the file was removed at the next start, and in the
//! environments of the hub and the memory store. It is removed and handed on
//! pipes now, but a password that was readable is not secret any more, so
//! the first start of this version changes it, once: a marker beside the
//! data says it has been.
//!
//! The change can be cut off anywhere without locking Desk out of its own
//! database. The new password is kept in the secret store first (under
//! [`POSTGRES_PASSWORD_NEXT_ACCOUNT`]); the database takes it second; it
//! becomes the password third. A start that finds one kept and not yet the
//! password asks the database which of the two it holds. This runs as soon
//! as Postgres is up, before anything signs in to it, so a start after a cut
//! reaches it.

use std::path::Path;

use desk_core::{POSTGRES_PASSWORD_NEXT_ACCOUNT, Secret, Secrets};
use eyre::{Result, eyre};
use sqlx::postgres::{PgConnectOptions, PgConnection};
use sqlx::{ConnectOptions, Connection};

/// The marker, in the hub's folder, of a password already changed.
pub const MARKER: &str = "postgres-password-rotated";

/// Where the secrets are kept.
pub trait Accounts {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

impl Accounts for Secrets {
    fn get(&self, account: &str) -> Result<Option<String>> {
        self.get_account(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        self.set_account(account, value)
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.delete_account(account)
    }
}

/// The database's password.
#[allow(async_fn_in_trait)]
pub trait Database {
    /// Whether `password` opens the database.
    async fn accepts(&self, password: &str) -> bool;
    /// Makes `new` the password, signing in with `current`.
    async fn change(&self, current: &str, new: &str) -> Result<()>;
}

/// The local Postgres, by TCP on loopback.
pub struct Local {
    pub port: u16,
    pub user: &'static str,
}

impl Local {
    async fn connect(&self, password: &str) -> Result<PgConnection> {
        let options = PgConnectOptions::new()
            .host("127.0.0.1")
            .port(self.port)
            .username(self.user)
            .password(password)
            .database("postgres")
            // The statement that changes the password has it in it, and
            // sqlx logs a slow statement (and every one at debug).
            .disable_statement_logging();
        Ok(PgConnection::connect_with(&options).await?)
    }
}

impl Database for Local {
    async fn accepts(&self, password: &str) -> bool {
        match self.connect(password).await {
            Ok(conn) => {
                let _ = conn.close().await;
                true
            }
            Err(_) => false,
        }
    }

    async fn change(&self, current: &str, new: &str) -> Result<()> {
        // A utility statement takes no parameters: what is put in it is only
        // ever Desk's own generated URL-safe base64.
        if new.is_empty()
            || !new
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(eyre!("the new password is not one Desk made"));
        }
        let mut conn = self.connect(current).await?;
        // Audited: `user` is a constant and `new` was checked above.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "ALTER ROLE \"{}\" PASSWORD '{new}'",
            self.user
        )))
        .execute(&mut conn)
        .await?;
        let _ = conn.close().await;
        Ok(())
    }
}

/// The password to use from here on: `current` changed once, or `current`
/// when it could not be (it is tried again at the next start, and nothing
/// is lost meanwhile).
pub async fn run(
    marker: &Path,
    accounts: &impl Accounts,
    database: &impl Database,
    current: String,
) -> String {
    if marker.exists() {
        return current;
    }
    match rotate(marker, accounts, database, &current).await {
        Ok(password) => {
            tracing::info!("Postgres's password changed");
            password
        }
        Err(e) => {
            tracing::warn!(error = %e, "Postgres's password was not changed; tried again at the next start");
            // It may be changed all the same, and only the keeping of it
            // failed: then the database takes the spare, not `current`.
            match accounts.get(POSTGRES_PASSWORD_NEXT_ACCOUNT) {
                Ok(Some(next)) if database.accepts(&next).await => next,
                _ => current,
            }
        }
    }
}

async fn rotate(
    marker: &Path,
    accounts: &impl Accounts,
    database: &impl Database,
    current: &str,
) -> Result<String> {
    let password = Secret::PostgresPassword;
    let next = match accounts.get(POSTGRES_PASSWORD_NEXT_ACCOUNT)? {
        Some(next) => {
            // A change that was cut off: if the database already has it,
            // that is the password; if not, it is still the one to change to.
            if database.accepts(&next).await {
                finish(marker, accounts, &next)?;
                return Ok(next);
            }
            next
        }
        None => {
            let next = password.generate();
            accounts.set(POSTGRES_PASSWORD_NEXT_ACCOUNT, &next)?;
            next
        }
    };
    database.change(current, &next).await?;
    finish(marker, accounts, &next)?;
    Ok(next)
}

fn finish(marker: &Path, accounts: &impl Accounts, next: &str) -> Result<()> {
    accounts.set(Secret::PostgresPassword.account(), next)?;
    // The marker goes before the spare is dropped: the password is already
    // the new one, so a failure past here costs only the spare's removal.
    desk_core::write_private(marker, "")?;
    if let Err(e) = accounts.delete(POSTGRES_PASSWORD_NEXT_ACCOUNT) {
        tracing::warn!(error = %e, "the spare Postgres password was not removed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Store(RefCell<HashMap<String, String>>, bool);
    impl Accounts for Store {
        fn get(&self, a: &str) -> Result<Option<String>> {
            Ok(self.0.borrow().get(a).cloned())
        }
        fn set(&self, a: &str, v: &str) -> Result<()> {
            if self.1 && a == Secret::PostgresPassword.account() {
                return Err(eyre!("the store refuses"));
            }
            self.0.borrow_mut().insert(a.into(), v.into());
            Ok(())
        }
        fn delete(&self, a: &str) -> Result<()> {
            self.0.borrow_mut().remove(a);
            Ok(())
        }
    }

    /// A database with a password, that can be made to refuse the change.
    struct Fake {
        password: RefCell<String>,
        refuses: bool,
    }
    impl Database for Fake {
        async fn accepts(&self, password: &str) -> bool {
            *self.password.borrow() == password
        }
        async fn change(&self, current: &str, new: &str) -> Result<()> {
            if self.refuses || *self.password.borrow() != current {
                return Err(eyre!("refused"));
            }
            *self.password.borrow_mut() = new.into();
            Ok(())
        }
    }

    fn fake(password: &str, refuses: bool) -> Fake {
        Fake {
            password: RefCell::new(password.into()),
            refuses,
        }
    }

    fn account() -> &'static str {
        Secret::PostgresPassword.account()
    }

    #[tokio::test]
    async fn the_password_changes_once() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(MARKER);
        let accounts = Store(Default::default(), false);
        accounts.set(account(), "old").unwrap();
        let db = fake("old", false);

        let now = run(&marker, &accounts, &db, "old".into()).await;
        assert_ne!(now, "old");
        assert_eq!(*db.password.borrow(), now);
        assert_eq!(
            accounts.get(account()).unwrap().as_deref(),
            Some(now.as_str())
        );
        assert_eq!(accounts.get(POSTGRES_PASSWORD_NEXT_ACCOUNT).unwrap(), None);
        assert!(marker.exists());

        // Marked: nothing more happens.
        let again = run(&marker, &accounts, &db, now.clone()).await;
        assert_eq!(again, now);
        assert_eq!(*db.password.borrow(), now);
    }

    #[tokio::test]
    async fn a_refused_change_keeps_the_old_password_and_tries_again() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(MARKER);
        let accounts = Store(Default::default(), false);
        accounts.set(account(), "old").unwrap();
        let db = fake("old", true);

        assert_eq!(run(&marker, &accounts, &db, "old".into()).await, "old");
        assert!(!marker.exists());
        assert_eq!(accounts.get(account()).unwrap().as_deref(), Some("old"));
        // The next start has the spare and the database still on the old one:
        // it changes to that spare.
        let spare = accounts
            .get(POSTGRES_PASSWORD_NEXT_ACCOUNT)
            .unwrap()
            .unwrap();
        let db = fake("old", false);
        assert_eq!(run(&marker, &accounts, &db, "old".into()).await, spare);
        assert_eq!(*db.password.borrow(), spare);
    }

    /// Cut off after the database took the new password and before the
    /// store did: the next start finds the spare is the password.
    #[tokio::test]
    async fn a_change_cut_off_after_the_database_took_it_is_finished() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(MARKER);
        let accounts = Store(Default::default(), false);
        accounts.set(account(), "old").unwrap();
        accounts
            .set(POSTGRES_PASSWORD_NEXT_ACCOUNT, "spare")
            .unwrap();
        let db = fake("spare", false);

        assert_eq!(run(&marker, &accounts, &db, "old".into()).await, "spare");
        assert_eq!(accounts.get(account()).unwrap().as_deref(), Some("spare"));
        assert_eq!(accounts.get(POSTGRES_PASSWORD_NEXT_ACCOUNT).unwrap(), None);
        assert!(marker.exists());
    }

    #[tokio::test]
    async fn a_password_not_made_by_desk_is_never_put_in_a_statement() {
        let local = Local {
            port: 1,
            user: "postgres",
        };
        for bad in ["", "a'; DROP ROLE x; --", "with space"] {
            let e = local.change("old", bad).await.unwrap_err();
            assert!(e.to_string().contains("not one Desk made"), "{e}");
        }
    }

    /// The database took the new password and the store would not keep it:
    /// this start uses the spare, and the next finds it the same way.
    #[tokio::test]
    async fn a_password_the_store_would_not_keep_is_still_the_one_used() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(MARKER);
        let accounts = Store(Default::default(), true);
        accounts.set("other", "x").unwrap();
        let db = fake("old", false);

        let now = run(&marker, &accounts, &db, "old".into()).await;
        assert_ne!(now, "old");
        assert_eq!(*db.password.borrow(), now);
        assert!(!marker.exists());
        assert_eq!(
            accounts
                .get(POSTGRES_PASSWORD_NEXT_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some(now.as_str())
        );
    }
}
