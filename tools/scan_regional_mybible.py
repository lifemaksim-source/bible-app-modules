"""Cross-check requested USSR, Warsaw Pact, Yugoslav and Mongolian languages
against the *actual* MyBible registry, and validate at most one ZIP per language.

Metadata-only: does not publish modules, modify catalog.json, or touch APK.
Example: python3 tools/scan_regional_mybible.py --output regional-module-audit.json
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from audit_mybible import AuditError, read_registry, registry_candidates, verify_zip

REGISTRY_URL = "https://mybible.zone/repository/registry/registry.zip"
ALLOW_HOSTS = {"mybible.zone", "mybible.infoo.pro"}
# Known upstream metadata uses a human language name rather than an ISO code.
LANGUAGE_LABEL_ALIASES = {"dar": {"dargi"}}

# ISO 639-1/3 identifiers as represented in MyBible's "lng" field.
# Explicit geography rather than a "top languages" popularity list.
LANGUAGE_GROUPS = {
    "former_ussr": (
        "ru uk be lt lv et az hy ka kk ky uz tg tk ro mo"
        " tt ba cv sah ce os udm chm mdf mrj myv kom kv bua tyv"
        " av ava agx ady dar ddo inh kbd lez lbe nog rut tab"
        " crh kaa ckt ale niv ab abk xmf"
    ).split(),
    "warsaw_pact": "pl cs sk hu ro bg sq de ru".split(),
    "former_yugoslavia": "sr hr bs sl mk cnr sh".split(),
    "mongolia": ["mn"],
}
ALL_LANGUAGES = sorted(set().union(*(set(v) for v in LANGUAGE_GROUPS.values())))


def permitted_https(url):
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in ALLOW_HOSTS


def retrieve(url, max_bytes):
    if not permitted_https(url):
        raise AuditError("Module URL host is not a trusted MyBible server")
    with urlopen(Request(url, headers={"User-Agent": "bible-app-modules/regional-audit"}), timeout=20) as response:
        if response.status != 200:
            raise AuditError(f"HTTP {response.status}")
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise AuditError("Remote file exceeds allowed size")
    return data


def summary_from_registry(registry, requested=None):
    requested = sorted(set(requested if requested is not None else ALL_LANGUAGES))
    entries = registry_candidates(registry, set(requested))
    grouped = {lang: [] for lang in requested}
    for entry in entries:
        grouped[entry["language"]].append({
            "file": entry["file"],
            "code": entry["code"],
            "name": entry["name"],
            "downloadUrls": [u for u in entry["downloadUrls"] if permitted_https(u)],
        })
    grouped = {lang: rows for lang, rows in grouped.items() if rows}
    return {
        "source": REGISTRY_URL,
        "registryVersion": registry.get("version"),
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": LANGUAGE_GROUPS,
        "requestedLanguageCodes": requested,
        "languagesWithOffers": len(grouped),
        "moduleOffers": sum(map(len, grouped.values())),
        "languages": {
            lang: {
                "registryEntries": len(rows),
                "offers": rows,
                "verified": None,
                "status": "registry_listing_not_checked",
            } for lang, rows in grouped.items()
        },
        "warning": "Registry entries are not proof of compatible SQLite, correct Scripture or Android support",
    }


def verify_one_per_language(report, download=retrieve):
    # Avoid repeated downloads/expensive CI. Try a second candidate only
    # if the first cannot be fetched or fails SQLite checks.
    with tempfile.TemporaryDirectory(prefix="regional-mybible-") as tmp:
        archive = Path(tmp) / "candidate.zip"
        for lang, entry in report["languages"].items():
            failures = []
            for offer in entry["offers"][:2]:
                for url in offer["downloadUrls"][:2]:
                    try:
                        archive.write_bytes(download(url, 100 * 1024 * 1024))
                        scanned = verify_zip(archive)
                        tag = scanned["language"].lower().split("-")[0].split("_")[0]
                        alias_match = tag != lang and tag in LANGUAGE_LABEL_ALIASES.get(lang, set())
                        if tag != lang and not alias_match:
                            raise AuditError(f"Module declares language {scanned['language']!r}, expected {lang!r}")
                        entry["verified"] = {
                            "file": offer["file"],
                            "url": url,
                            "books": scanned["books"],
                            "nonEmptyVerseRows": scanned["nonEmptyVerseRows"],
                            "blankVerseRows": scanned["blankVerseRows"],
                            "sqliteSha256": scanned["sqliteSha256"],
                            "sqliteEntry": scanned["sqliteEntry"],
                            "warnings": scanned["warnings"] + (
                                [f"Header language {scanned['language']!r} is a known display-name alias for {lang!r}"]
                                if alias_match else []
                            ),
                            "status": "structural_sqlite_only_android_not_tested",
                        }
                        entry["status"] = "one_archive_sqlite_verified"
                        break
                    except (OSError, ValueError, RuntimeError, UnicodeError, __import__("zipfile").BadZipFile,
                            __import__("sqlite3").DatabaseError) as exc:
                        failures.append({"file": offer["file"], "reason": str(exc)[:180]})
                if entry["verified"]:
                    break
            if entry["verified"] is None:
                entry["status"] = "no_compatible_archive_verified"
                entry["failures"] = failures[:4]
    report["languagesWithVerifiedSqlite"] = sum(x["verified"] is not None for x in report["languages"].values())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", help="Optional local registry.zip (else use official HTTPS)")
    parser.add_argument("--output", default="regional-module-audit.json")
    parser.add_argument("--no-probe", action="store_true", help="Only list registry metadata, no archive requests")
    args = parser.parse_args()
    try:
        with tempfile.TemporaryDirectory(prefix="regional-registry-") as tmp:
            if args.registry:
                source = args.registry
            else:
                source = str(Path(tmp) / "registry.zip")
                Path(source).write_bytes(retrieve(REGISTRY_URL, 32 * 1024 * 1024))
            report = summary_from_registry(read_registry(source))
        if not args.no_probe:
            verify_one_per_language(report)
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, RuntimeError, ValueError, __import__("zipfile").BadZipFile) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(f"Registry v{report['registryVersion']}: {report['languagesWithOffers']} languages, "
          f"{report['moduleOffers']} module listings; "
          f"{report.get('languagesWithVerifiedSqlite', 'not tested')} have a validated SQLite.")
    for lang, data in report["languages"].items():
        checked = data["verified"]
        print(f"{lang}: {data['registryEntries']} entries, "
              f"{checked['books']} books and {checked['nonEmptyVerseRows']} nonempty verses"
              if checked else f"{lang}: {data['registryEntries']} entries, not SQLite-verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
