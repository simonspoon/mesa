//! Naru's environment variables during the mesa → Naru rename (mesa task
//! 1301): every `MESA_<NAME>` Naru reads is also readable as `NARU_<NAME>`,
//! and the new spelling is read first. The old one is still honoured, so no
//! script, gate or shell profile has to change when the binary does.

/// The value of `NARU_<name>`, else `MESA_<name>` — `name` is the shared
/// suffix, e.g. `"DB"`.
///
/// One rule for every call site: **an empty `NARU_<name>` never masks a
/// non-empty `MESA_<name>`**. The first *non-empty* value wins; when neither
/// is non-empty, whichever is set is returned as-is (`NARU_` first), so a
/// site that honours an empty value (`MESA_HOOKS_FILE=`) still sees one and a
/// site that treats empty as unset (`MESA_DB=`) keeps its own filter. With
/// only one spelling set, every site behaves exactly as it did before the
/// rename. A value that is not valid unicode counts as unset, as it did under
/// `std::env::var`.
pub fn var(name: &str) -> Option<String> {
    let naru = std::env::var(format!("NARU_{name}")).ok();
    let mesa = std::env::var(format!("MESA_{name}")).ok();
    match (naru, mesa) {
        (Some(n), _) if !n.is_empty() => Some(n),
        (_, Some(m)) if !m.is_empty() => Some(m),
        (n, m) => n.or(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::attachments::ENV_LOCK;

    // A suffix no other code reads, so the only writer is this test.
    const PROBE: &str = "ENV_FALLBACK_PROBE";

    fn set(prefix: &str, value: Option<&str>) {
        let key = format!("{prefix}_{PROBE}");
        // SAFETY: ENV_LOCK gives this test exclusive access to the env vars.
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    #[test]
    fn naru_is_read_first_and_mesa_is_still_honoured() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let cases: &[(Option<&str>, Option<&str>, Option<&str>)] = &[
            // (NARU_, MESA_, expected)
            (None, None, None),
            (Some("new"), None, Some("new")),
            (None, Some("old"), Some("old")),
            (Some("new"), Some("old"), Some("new")),
            // An empty NARU_ never masks a real MESA_ …
            (Some(""), Some("old"), Some("old")),
            // … and an empty MESA_ never masks a real NARU_.
            (Some("new"), Some(""), Some("new")),
            // Nothing non-empty: the set value comes back empty, so a site
            // that honours empty still sees it.
            (Some(""), None, Some("")),
            (None, Some(""), Some("")),
            (Some(""), Some(""), Some("")),
        ];
        for (naru, mesa, want) in cases {
            set("NARU", *naru);
            set("MESA", *mesa);
            assert_eq!(
                var(PROBE).as_deref(),
                *want,
                "NARU_={naru:?} MESA_={mesa:?}"
            );
        }
        set("NARU", None);
        set("MESA", None);
    }
}
