//! Recently used files, kept in `recent.json` in the app data directory.
//! Only ids, names and dates reach the webview; the paths stay here and are
//! granted again (as new tokens) when a recent file is reopened.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const MAX_RECENT: usize = 10;
const MAX_STORED_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    path: PathBuf,
    opened_at: String,
}

/// `RecentFile` in the frontend. Never contains the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub id: String,
    pub name: String,
    pub opened_at: String,
}

/// What the native Open Recent menu shows for an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuEntry {
    pub id: String,
    /// The file name, followed by its folder's name when several entries
    /// share a file name.
    pub label: String,
}

/// Ids are random and only ever generated here: 32 lowercase hex digits.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub struct RecentFiles {
    /// `None` when there is no data directory: the list then lasts for the session.
    file: Option<PathBuf>,
    entries: Mutex<Vec<Entry>>,
}

impl RecentFiles {
    /// Loads the list, dropping anything malformed.
    pub fn load(file: Option<PathBuf>) -> Self {
        let mut entries: Vec<Entry> = file
            .as_deref()
            .and_then(|file| paths::read_limited(file, MAX_STORED_BYTES).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        entries.retain(|entry| {
            is_valid_id(&entry.id) && entry.path.is_absolute() && !entry.name.is_empty()
        });
        let mut seen = Vec::new();
        entries.retain(|entry| {
            let new = !seen.contains(&entry.path);
            seen.push(entry.path.clone());
            new
        });
        entries.truncate(MAX_RECENT);
        RecentFiles {
            file,
            entries: Mutex::new(entries),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, entries: &[Entry]) {
        let Some(file) = &self.file else {
            return;
        };
        let Ok(json) = serde_json::to_vec_pretty(entries) else {
            return;
        };
        // Losing the list is not worth interrupting the user for.
        if let Some(folder) = file.parent() {
            let _ = paths::create_private_dir(folder);
        }
        let _ = paths::write_atomically(file, &json);
    }

    /// Puts a file the user opened or saved at the top, keeping its id if it
    /// was listed already. Returns whether the list changed.
    pub fn record(&self, path: &Path, name: &str) -> bool {
        let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        // The list is stored as JSON, which cannot hold other paths.
        if path.to_str().is_none() || !path.is_absolute() || name.is_empty() {
            return false;
        }
        let mut entries = self.lock();
        let id = match entries.iter().position(|entry| entry.path == path) {
            Some(index) => entries.remove(index).id,
            None => uuid::Uuid::new_v4().simple().to_string(),
        };
        entries.insert(
            0,
            Entry {
                id,
                name: name.to_owned(),
                path,
                opened_at: crate::time::now(),
            },
        );
        entries.truncate(MAX_RECENT);
        self.save(&entries);
        true
    }

    /// Newest first.
    pub fn list(&self) -> Vec<RecentFile> {
        self.lock()
            .iter()
            .map(|entry| RecentFile {
                id: entry.id.clone(),
                name: entry.name.clone(),
                opened_at: entry.opened_at.clone(),
            })
            .collect()
    }

    pub fn menu_entries(&self) -> Vec<MenuEntry> {
        let entries = self.lock();
        entries
            .iter()
            .map(|entry| {
                let shared = entries.iter().filter(|e| e.name == entry.name).count() > 1;
                let folder = entry
                    .path
                    .parent()
                    .and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned());
                let label = match folder {
                    Some(folder) if shared => format!("{} — {folder}", entry.name),
                    _ => entry.name.clone(),
                };
                MenuEntry {
                    id: entry.id.clone(),
                    label,
                }
            })
            .collect()
    }

    /// The path and name of a listed file.
    pub fn lookup(&self, id: &str) -> Option<(PathBuf, String)> {
        self.lock()
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| (entry.path.clone(), entry.name.clone()))
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut entries = self.lock();
        let before = entries.len();
        entries.retain(|entry| entry.id != id);
        let changed = entries.len() != before;
        if changed {
            self.save(&entries);
        }
        changed
    }

    pub fn clear(&self) -> bool {
        let mut entries = self.lock();
        let changed = !entries.is_empty();
        entries.clear();
        if changed {
            self.save(&entries);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn pdf(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"%PDF-1.7").unwrap();
        path
    }

    fn names(recent: &RecentFiles) -> Vec<String> {
        recent.list().into_iter().map(|file| file.name).collect()
    }

    #[test]
    fn lists_files_newest_first_and_without_paths() {
        let dir = tempfile::tempdir().unwrap();
        let recent = RecentFiles::load(Some(dir.path().join("recent.json")));
        assert!(recent.record(&pdf(dir.path(), "a.pdf"), "a.pdf"));
        assert!(recent.record(&pdf(dir.path(), "b.pdf"), "b.pdf"));
        assert_eq!(names(&recent), ["b.pdf", "a.pdf"]);
        let listed = recent.list();
        assert!(listed.iter().all(|file| is_valid_id(&file.id)));
        assert!(crate::time::parse_iso8601(&listed[0].opened_at).is_some());
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains(&*dir.path().to_string_lossy()));
        assert!(!json.contains("path"));
    }

    #[test]
    fn reopening_moves_a_file_to_the_top_and_keeps_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let recent = RecentFiles::load(None);
        let a = pdf(dir.path(), "a.pdf");
        recent.record(&a, "a.pdf");
        let id = recent.list()[0].id.clone();
        recent.record(&pdf(dir.path(), "b.pdf"), "b.pdf");
        // The same file through another spelling of its path.
        recent.record(&dir.path().join(".").join("a.pdf"), "a.pdf");
        assert_eq!(names(&recent), ["a.pdf", "b.pdf"]);
        assert_eq!(recent.list()[0].id, id);
        assert_eq!(
            recent.lookup(&id),
            Some((fs::canonicalize(&a).unwrap(), "a.pdf".to_owned()))
        );
    }

    #[test]
    fn keeps_at_most_ten_files() {
        let dir = tempfile::tempdir().unwrap();
        let recent = RecentFiles::load(None);
        for index in 0..12 {
            let name = format!("{index}.pdf");
            recent.record(&pdf(dir.path(), &name), &name);
        }
        let listed = names(&recent);
        assert_eq!(listed.len(), MAX_RECENT);
        assert_eq!(listed.first().map(String::as_str), Some("11.pdf"));
        assert_eq!(listed.last().map(String::as_str), Some("2.pdf"));
    }

    #[test]
    fn persists_removals_and_clearing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data").join("recent.json");
        let recent = RecentFiles::load(Some(file.clone()));
        recent.record(&pdf(dir.path(), "a.pdf"), "a.pdf");
        recent.record(&pdf(dir.path(), "b.pdf"), "b.pdf");
        let reloaded = RecentFiles::load(Some(file.clone()));
        assert_eq!(reloaded.list(), recent.list());

        let b = recent.list()[0].id.clone();
        assert!(recent.remove(&b));
        assert!(!recent.remove(&b));
        assert_eq!(names(&RecentFiles::load(Some(file.clone()))), ["a.pdf"]);
        assert!(recent.clear());
        assert!(!recent.clear());
        assert!(RecentFiles::load(Some(file)).list().is_empty());
    }

    #[test]
    fn ignores_a_damaged_list() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        fs::write(&file, b"{ not json").unwrap();
        assert!(RecentFiles::load(Some(file.clone())).list().is_empty());
        let absolute = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        let entries = serde_json::json!([
            { "id": "../../etc", "name": "a.pdf", "path": absolute("a.pdf"), "openedAt": "x" },
            { "id": "0123456789abcdef0123456789abcdef", "name": "b.pdf", "path": "relative.pdf", "openedAt": "x" },
            { "id": "0123456789abcdef0123456789abcde0", "name": "c.pdf", "path": absolute("c.pdf"), "openedAt": "x" },
            { "id": "0123456789abcdef0123456789abcde1", "name": "c.pdf", "path": absolute("c.pdf"), "openedAt": "x" },
            { "id": "0123456789abcdef0123456789abcde2", "name": "", "path": absolute("d.pdf"), "openedAt": "x" }
        ]);
        fs::write(&file, serde_json::to_vec(&entries).unwrap()).unwrap();
        let ids: Vec<_> = RecentFiles::load(Some(file))
            .list()
            .into_iter()
            .map(|file| file.id)
            .collect();
        assert_eq!(ids, ["0123456789abcdef0123456789abcde0"]);
    }

    #[test]
    fn labels_files_with_the_same_name_by_folder() {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["2025", "2026"] {
            fs::create_dir(dir.path().join(folder)).unwrap();
        }
        let recent = RecentFiles::load(None);
        recent.record(&pdf(&dir.path().join("2025"), "Taxes.pdf"), "Taxes.pdf");
        recent.record(&pdf(&dir.path().join("2026"), "Taxes.pdf"), "Taxes.pdf");
        recent.record(&pdf(dir.path(), "Notes.pdf"), "Notes.pdf");
        let labels: Vec<_> = recent
            .menu_entries()
            .into_iter()
            .map(|entry| entry.label)
            .collect();
        assert_eq!(
            labels,
            ["Notes.pdf", "Taxes.pdf — 2026", "Taxes.pdf — 2025"]
        );
    }

    #[test]
    fn unknown_ids_are_not_found() {
        let recent = RecentFiles::load(None);
        assert_eq!(recent.lookup("0123456789abcdef0123456789abcdef"), None);
        assert!(!recent.remove("nope"));
    }
}
