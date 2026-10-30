//! The font families installed on this computer, for Settings → Appearance.

use std::collections::BTreeMap;

/// Each family once, named as its fonts name it (in English where they
/// say), sorted without regard to case; hidden system families (`.SF NS`)
/// left out.
pub fn families<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    names
        .into_iter()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .map(|name| (name.to_lowercase(), name.to_string()))
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect()
}

fn installed() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let names: Vec<String> = db
        .faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect();
    families(names.iter().map(String::as_str))
}

#[tauri::command]
pub async fn fonts_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(installed)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_family_shows_once_sorted_and_hidden_ones_are_left_out() {
        assert_eq!(
            families([
                "Menlo",
                "avenir",
                "Menlo",
                ".SF NS",
                " ",
                "Avenir Next",
                "Georgia"
            ]),
            vec!["avenir", "Avenir Next", "Georgia", "Menlo"]
        );
    }
}
