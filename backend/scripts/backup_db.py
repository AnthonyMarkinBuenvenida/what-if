"""Back up the What-if database.

    python -m scripts.backup_db                # SQLite: consistent copy into backend/data/backups/
    python -m scripts.backup_db --out D:\\safe  # choose the folder

SQLite is copied with SQLite's online backup API, so it is safe while the server is running.
For Postgres (DATABASE_URL), this prints the pg_dump command to use instead; hosted providers
such as Neon also keep their own point-in-time history.
Restore a SQLite backup by stopping the backend and copying the file back to backend/data/startup.db.
"""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime
from pathlib import Path

from app.config import DATA_DIR
from app.db import engine


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=DATA_DIR / "backups")
    args = ap.parse_args()
    if engine.url.get_backend_name() != "sqlite":
        print("This database is Postgres. Back it up with:\n"
              "  pg_dump --format=custom --file whatif.dump \"$DATABASE_URL\"\n"
              "and restore with pg_restore. Neon also offers point-in-time restore in its console.")
        return
    src = Path(engine.url.database)
    args.out.mkdir(parents=True, exist_ok=True)
    dst = args.out / f"whatif-{datetime.now():%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(src) as a, sqlite3.connect(dst) as b:
        a.backup(b)
    print(f"Backed up {src} -> {dst} ({dst.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
