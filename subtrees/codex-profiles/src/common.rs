use directories::BaseDirs;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(test)]
use std::cell::Cell;
#[cfg(test)]
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    COMMON_ERR_CREATE_DIR, COMMON_ERR_CREATE_PROFILES_DIR, COMMON_ERR_CREATE_TEMP,
    COMMON_ERR_EXISTS_NOT_DIR, COMMON_ERR_EXISTS_NOT_FILE, COMMON_ERR_GET_TIME,
    COMMON_ERR_INVALID_FILE_NAME, COMMON_ERR_READ_FILE, COMMON_ERR_READ_METADATA,
    COMMON_ERR_REPLACE_FILE, COMMON_ERR_RESOLVE_HOME, COMMON_ERR_RESOLVE_PARENT,
    COMMON_ERR_SET_PERMISSIONS, COMMON_ERR_SET_TEMP_PERMISSIONS, COMMON_ERR_WRITE_LOCK_FILE,
    COMMON_ERR_WRITE_TEMP,
};

pub struct Paths {
    pub codex: PathBuf,
    pub auth: PathBuf,
    pub profiles: PathBuf,
    pub profiles_index: PathBuf,
    pub update_cache: PathBuf,
    pub profiles_lock: PathBuf,
}

pub fn command_name() -> &'static str {
    static COMMAND_NAME: OnceLock<String> = OnceLock::new();
    COMMAND_NAME
        .get_or_init(|| {
            let env_value = env::var("CODEX_PROFILES_COMMAND").ok();
            compute_command_name_from(env_value, env::args_os())
        })
        .as_str()
}

fn compute_command_name_from<I>(env_value: Option<String>, mut args: I) -> String
where
    I: Iterator<Item = std::ffi::OsString>,
{
    if let Some(value) = env_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    args.next()
        .and_then(|arg| {
            Path::new(&arg)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "codex-profiles".to_string())
}

pub fn package_command_name() -> &'static str {
    "codex-profiles"
}

#[cfg(unix)]
const FAIL_SET_PERMISSIONS: usize = 1;
const FAIL_WRITE_OPEN: usize = 2;
const FAIL_WRITE_WRITE: usize = 3;
const FAIL_WRITE_PERMS: usize = 4;
const FAIL_WRITE_SYNC: usize = 5;
const FAIL_WRITE_RENAME: usize = 6;

#[cfg(test)]
thread_local! {
    static FAILPOINT: Cell<usize> = const { Cell::new(0) };
}
#[cfg(test)]
static FAILPOINT_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn maybe_fail(step: usize) -> std::io::Result<()> {
    if FAILPOINT.with(|failpoint| failpoint.get()) == step {
        return Err(std::io::Error::other("failpoint"));
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_fail(_step: usize) -> std::io::Result<()> {
    Ok(())
}

pub fn resolve_paths() -> Result<Paths, String> {
    let home_dir = resolve_home_dir().ok_or_else(|| COMMON_ERR_RESOLVE_HOME.to_string())?;
    let codex_dir = home_dir.join(".codex");
    let auth = codex_dir.join("auth.json");
    let profiles = codex_dir.join("profiles");
    let profiles_index = profiles.join("profiles.json");
    let update_cache = profiles.join("update.json");
    let profiles_lock = profiles.join("profiles.lock");
    Ok(Paths {
        codex: codex_dir,
        auth,
        profiles,
        profiles_index,
        update_cache,
        profiles_lock,
    })
}

fn resolve_home_dir() -> Option<PathBuf> {
    let codex_home = env::var_os("CODEX_PROFILES_HOME").map(PathBuf::from);
    let base_home = BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    let home = env::var_os("HOME").map(PathBuf::from);
    let userprofile = env::var_os("USERPROFILE").map(PathBuf::from);
    let homedrive = env::var_os("HOMEDRIVE").map(PathBuf::from);
    let homepath = env::var_os("HOMEPATH").map(PathBuf::from);
    resolve_home_dir_with(
        codex_home,
        base_home,
        home,
        userprofile,
        homedrive,
        homepath,
    )
}

fn resolve_home_dir_with(
    codex_home: Option<PathBuf>,
    base_home: Option<PathBuf>,
    home: Option<PathBuf>,
    userprofile: Option<PathBuf>,
    homedrive: Option<PathBuf>,
    homepath: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = non_empty_path(codex_home) {
        return Some(path);
    }
    if let Some(path) = base_home {
        return Some(path);
    }
    if let Some(path) = non_empty_path(home) {
        return Some(path);
    }
    if let Some(path) = non_empty_path(userprofile) {
        return Some(path);
    }
    match (homedrive, homepath) {
        (Some(drive), Some(path)) => {
            let mut out = drive;
            out.push(path);
            if out.as_os_str().is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn non_empty_path(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|path| !path.as_os_str().is_empty())
}

pub fn ensure_paths(paths: &Paths) -> Result<(), String> {
    if paths.profiles.exists() && !paths.profiles.is_dir() {
        return Err(crate::msg1(
            COMMON_ERR_EXISTS_NOT_DIR,
            paths.profiles.display(),
        ));
    }

    fs::create_dir_all(&paths.profiles).map_err(|err| {
        crate::msg2(
            COMMON_ERR_CREATE_PROFILES_DIR,
            paths.profiles.display(),
            err,
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o700);
        if let Err(err) = set_profile_permissions(&paths.profiles, perms) {
            return Err(crate::msg2(
                COMMON_ERR_SET_PERMISSIONS,
                paths.profiles.display(),
                err,
            ));
        }
    }

    ensure_file_or_absent(&paths.profiles_index)?;
    ensure_file_or_absent(&paths.update_cache)?;
    ensure_file_or_absent(&paths.profiles_lock)?;

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.profiles_lock)
        .map_err(|err| {
            crate::msg2(
                COMMON_ERR_WRITE_LOCK_FILE,
                paths.profiles_lock.display(),
                err,
            )
        })?;

    Ok(())
}

pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let permissions = fs::metadata(path).ok().map(|meta| meta.permissions());
    write_atomic_with_permissions(path, contents, permissions)
}

#[cfg(test)]
pub fn write_atomic_with_mode(path: &Path, contents: &[u8], mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(mode);
        write_atomic_with_permissions(path, contents, Some(permissions))
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        write_atomic_with_permissions(path, contents, None)
    }
}

fn write_atomic_with_permissions(
    path: &Path,
    contents: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| crate::msg1(COMMON_ERR_RESOLVE_PARENT, path.display()))?;
    if !parent.as_os_str().is_empty() {
        fs::create_dir_all(parent)
            .map_err(|err| crate::msg2(COMMON_ERR_CREATE_DIR, parent.display(), err))?;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| crate::msg1(COMMON_ERR_INVALID_FILE_NAME, path.display()))?;
    let pid = std::process::id();
    let mut attempt = 0u32;
    loop {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| crate::msg1(COMMON_ERR_GET_TIME, err))?
            .as_nanos();
        let tmp_name = format!(".{file_name}.tmp-{pid}-{nanos}-{attempt}");
        let tmp_path = parent.join(tmp_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(permissions) = permissions.as_ref() {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(permissions.mode());
        }
        let mut tmp_file = match options.open(&tmp_path).and_then(|file| {
            maybe_fail(FAIL_WRITE_OPEN)?;
            Ok(file)
        }) {
            Ok(file) => file,
            Err(err) => {
                attempt += 1;
                if attempt < 5 {
                    continue;
                }
                return Err(crate::msg2(COMMON_ERR_CREATE_TEMP, path.display(), err));
            }
        };

        maybe_fail(FAIL_WRITE_WRITE)
            .and_then(|_| tmp_file.write_all(contents))
            .map_err(|err| crate::msg2(COMMON_ERR_WRITE_TEMP, path.display(), err))?;

        if let Some(permissions) = permissions {
            maybe_fail(FAIL_WRITE_PERMS)
                .and_then(|_| fs::set_permissions(&tmp_path, permissions))
                .map_err(|err| crate::msg2(COMMON_ERR_SET_TEMP_PERMISSIONS, path.display(), err))?;
        }

        maybe_fail(FAIL_WRITE_SYNC)
            .and_then(|_| tmp_file.sync_all())
            .map_err(|err| crate::msg2(COMMON_ERR_WRITE_TEMP, path.display(), err))?;

        let rename_result = maybe_fail(FAIL_WRITE_RENAME).and_then(|_| fs::rename(&tmp_path, path));
        match rename_result {
            Ok(()) => return Ok(()),
            Err(err) => {
                #[cfg(windows)]
                {
                    if path.exists() {
                        let _ = fs::remove_file(path);
                    }
                    if fs::rename(&tmp_path, path).is_ok() {
                        return Ok(());
                    }
                }
                let _ = fs::remove_file(&tmp_path);
                return Err(crate::msg2(COMMON_ERR_REPLACE_FILE, path.display(), err));
            }
        }
    }
}

pub fn copy_atomic(source: &Path, dest: &Path) -> Result<(), String> {
    let permissions = fs::metadata(source)
        .map_err(|err| crate::msg2(COMMON_ERR_READ_METADATA, source.display(), err))?
        .permissions();
    let contents =
        fs::read(source).map_err(|err| crate::msg2(COMMON_ERR_READ_FILE, source.display(), err))?;
    write_atomic_with_permissions(dest, &contents, Some(permissions))
}

fn ensure_file_or_absent(path: &Path) -> Result<(), String> {
    if path.exists() && !path.is_file() {
        return Err(crate::msg1(COMMON_ERR_EXISTS_NOT_FILE, path.display()));
    }
    Ok(())
}

#[cfg(unix)]
fn set_profile_permissions(path: &Path, perms: fs::Permissions) -> std::io::Result<()> {
    maybe_fail(FAIL_SET_PERMISSIONS)?;
    fs::set_permissions(path, perms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::make_paths;
    use std::ffi::OsString;
    use std::fs;

    fn with_failpoint<F: FnOnce()>(step: usize, f: F) {
        let _guard = FAILPOINT_LOCK.lock().unwrap();
        let prev = FAILPOINT.with(|failpoint| {
            let prev = failpoint.get();
            failpoint.set(step);
            prev
        });
        f();
        FAILPOINT.with(|failpoint| failpoint.set(prev));
    }

    fn with_failpoint_disabled<F: FnOnce()>(f: F) {
        let _guard = FAILPOINT_LOCK.lock().unwrap();
        let prev = FAILPOINT.with(|failpoint| {
            let prev = failpoint.get();
            failpoint.set(0);
            prev
        });
        f();
        FAILPOINT.with(|failpoint| failpoint.set(prev));
    }

    #[test]
    fn compute_command_name_uses_env() {
        let name = compute_command_name_from(Some("mycmd".to_string()), Vec::new().into_iter());
        assert_eq!(name, "mycmd");
    }

    #[test]
    fn compute_command_name_uses_args() {
        let args = vec![OsString::from("/usr/bin/codex-profiles")];
        let name = compute_command_name_from(None, args.into_iter());
        assert_eq!(name, "codex-profiles");
    }

    #[test]
    fn compute_command_name_ignores_blank_env() {
        let args = vec![OsString::from("/usr/local/bin/custom")];
        let name = compute_command_name_from(Some("   ".to_string()), args.into_iter());
        assert_eq!(name, "custom");
    }

    #[test]
    fn compute_command_name_fallback() {
        let name = compute_command_name_from(None, Vec::new().into_iter());
        assert_eq!(name, "codex-profiles");
    }

    #[test]
    fn resolve_home_dir_prefers_codex_env() {
        let out = resolve_home_dir_with(
            Some(PathBuf::from("/tmp/codex")),
            Some(PathBuf::from("/tmp/base")),
            Some(PathBuf::from("/tmp/home")),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(out, PathBuf::from("/tmp/codex"));
    }

    #[test]
    fn resolve_home_dir_uses_base_dirs() {
        let out = resolve_home_dir_with(
            None,
            Some(PathBuf::from("/tmp/base")),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(out, PathBuf::from("/tmp/base"));
    }

    #[test]
    fn resolve_home_dir_falls_back() {
        let out = resolve_home_dir_with(
            Some(PathBuf::from("")),
            None,
            Some(PathBuf::from("/tmp/home")),
            Some(PathBuf::from("/tmp/user")),
            Some(PathBuf::from("C:")),
            Some(PathBuf::from("/Users")),
        )
        .unwrap();
        assert_eq!(out, PathBuf::from("/tmp/home"));
    }

    #[test]
    fn resolve_home_dir_uses_userprofile() {
        let out = resolve_home_dir_with(
            None,
            None,
            None,
            Some(PathBuf::from("/tmp/user")),
            None,
            None,
        )
        .unwrap();
        assert_eq!(out, PathBuf::from("/tmp/user"));
    }

    #[test]
    fn resolve_home_dir_uses_drive() {
        let out = resolve_home_dir_with(
            None,
            None,
            None,
            None,
            Some(PathBuf::from("C:")),
            Some(PathBuf::from("Users")),
        )
        .unwrap();
        assert_eq!(out, PathBuf::from("C:/Users"));
    }

    #[test]
    fn resolve_home_dir_none_when_empty() {
        assert!(resolve_home_dir_with(None, None, None, None, None, None).is_none());
    }

    #[test]
    fn resolve_home_dir_ignores_empty_values() {
        assert!(
            resolve_home_dir_with(None, None, Some(PathBuf::from("")), None, None, None,).is_none()
        );
        assert!(
            resolve_home_dir_with(None, None, None, Some(PathBuf::from("")), None, None,).is_none()
        );
        assert!(
            resolve_home_dir_with(
                None,
                None,
                None,
                None,
                Some(PathBuf::from("")),
                Some(PathBuf::from("")),
            )
            .is_none()
        );
    }

    #[test]
    fn ensure_paths_errors_when_profiles_is_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profiles = dir.path().join("profiles");
        fs::write(&profiles, "not a dir").expect("write");
        let paths = make_paths(dir.path());
        let err = ensure_paths(&paths).unwrap_err();
        assert!(err.contains("not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_paths_errors_when_unwritable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let locked = dir.path().join("locked");
        fs::create_dir_all(&locked).expect("create");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o400)).expect("chmod");
        let profiles = locked.join("profiles");
        let mut paths = make_paths(dir.path());
        paths.profiles = profiles.clone();
        paths.profiles_index = profiles.join("profiles.json");
        paths.profiles_lock = profiles.join("profiles.lock");
        let err = ensure_paths(&paths).unwrap_err();
        assert!(err.contains("Cannot create profiles directory"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_paths_permissions_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        with_failpoint(FAIL_SET_PERMISSIONS, || {
            let err = ensure_paths(&paths).unwrap_err();
            assert!(err.contains("Cannot set permissions"));
        });
    }

    #[cfg(unix)]
    #[test]
    fn ensure_paths_profiles_lock_open_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let profiles = dir.path().join("profiles");
        fs::create_dir_all(&profiles).expect("create");
        let lock = profiles.join("profiles.lock");
        fs::write(&lock, "").expect("write lock");
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o400)).expect("chmod");
        let mut paths = make_paths(dir.path());
        paths.profiles_lock = lock.clone();
        let err = ensure_paths(&paths).unwrap_err();
        assert!(err.contains("Cannot write profiles lock file"));
    }

    #[test]
    fn write_atomic_success() {
        with_failpoint_disabled(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join("file.txt");
            write_atomic(&path, b"hello").unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
        });
    }

    #[test]
    fn write_atomic_invalid_parent() {
        let err = write_atomic(Path::new(""), b"hi").unwrap_err();
        assert!(err.contains("parent directory"));
    }

    #[test]
    fn write_atomic_invalid_filename() {
        let err = write_atomic(Path::new("/"), b"hi").unwrap_err();
        assert!(err.contains("invalid file name") || err.contains("parent directory"));
    }

    #[test]
    fn write_atomic_create_dir_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "file").expect("write");
        let path = blocker.join("child.txt");
        let err = write_atomic(&path, b"data").unwrap_err();
        assert!(err.contains("Cannot create directory"));
    }

    #[test]
    fn write_atomic_open_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file.txt");
        with_failpoint(FAIL_WRITE_OPEN, || {
            let err = write_atomic(&path, b"data").unwrap_err();
            assert!(err.contains("Failed to create temp file"));
        });
    }

    #[test]
    fn write_atomic_write_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file.txt");
        with_failpoint(FAIL_WRITE_WRITE, || {
            let err = write_atomic(&path, b"data").unwrap_err();
            assert!(err.contains("Failed to write temp file"));
        });
    }

    #[test]
    fn write_atomic_permissions_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file.txt");
        with_failpoint(FAIL_WRITE_PERMS, || {
            let err = write_atomic_with_mode(&path, b"data", 0o600).unwrap_err();
            assert!(err.contains("Failed to set temp file permissions"));
        });
    }

    #[test]
    fn write_atomic_sync_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file.txt");
        with_failpoint(FAIL_WRITE_SYNC, || {
            let err = write_atomic(&path, b"data").unwrap_err();
            assert!(err.contains("Failed to write temp file"));
        });
    }

    #[test]
    fn write_atomic_rename_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file.txt");
        with_failpoint(FAIL_WRITE_RENAME, || {
            let err = write_atomic(&path, b"data").unwrap_err();
            assert!(err.contains("Failed to replace"));
        });
    }

    #[test]
    fn copy_atomic_reads_source() {
        with_failpoint_disabled(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let source = dir.path().join("source.txt");
            let dest = dir.path().join("dest.txt");
            fs::write(&source, "copy").expect("write");
            copy_atomic(&source, &dest).unwrap();
            assert_eq!(fs::read_to_string(&dest).unwrap(), "copy");
        });
    }

    #[test]
    fn copy_atomic_missing_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("missing.txt");
        let dest = dir.path().join("dest.txt");
        let err = copy_atomic(&source, &dest).unwrap_err();
        assert!(err.contains("Failed to read metadata"));
    }

    #[test]
    fn ensure_file_or_absent_errors_on_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = ensure_file_or_absent(dir.path()).unwrap_err();
        assert!(err.contains("exists and is not a file"));
    }
}
