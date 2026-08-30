use std::fs::File;
use std::io;

// Serialize startup until Tauri's single-instance listener and main window exist.
// The plugin alone has a mutex/window-creation race on concurrent Windows launches.
pub fn lock(identifier: &str) -> io::Result<File> {
    if !identifier
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(std::env::temp_dir().join(format!("{identifier}.startup.lock")))?;
    file.lock()?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let id = format!("udmc-test-startup-{}", std::process::id());
        let first = lock(&id).unwrap();
        let path = std::env::temp_dir().join(format!("{id}.startup.lock"));
        let second = File::options().read(true).write(true).open(&path).unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn lock_name_cannot_escape_temp_directory() {
        assert!(lock("../elsewhere").is_err());
        assert!(lock("C:\\elsewhere").is_err());
    }
}
