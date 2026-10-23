"""Local admin tool for workspaces (StartUp has no accounts).

    python -m scripts.workspaces list
    python -m scripts.workspaces move --from 1 --to 7

`move` reassigns every business (with its models, runs, reports, feedback and
failure records) from one workspace to another. Use it to bring data created
before the no-login change into the workspace shown under Settings in your
browser. Run it while the server is stopped, after taking a backup.
"""
from __future__ import annotations

import argparse

from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import Business, Workspace


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    mv = sub.add_parser("move")
    mv.add_argument("--from", dest="src", type=int, required=True)
    mv.add_argument("--to", dest="dst", type=int, required=True)
    args = ap.parse_args()
    init_db()
    db = SessionLocal()
    try:
        if args.cmd == "list":
            rows = db.execute(select(Workspace.id, Workspace.created_at, Workspace.password_hash, func.count(Business.id))
                              .outerjoin(Business, Business.user_id == Workspace.id).group_by(Workspace.id)).all()
            for wid, created, pw, n in rows:
                kind = "anonymous" if pw == "!" else "legacy (from the account era)"
                print(f"workspace {wid:>4}  {kind:<30} businesses: {n:<4} created: {created:%Y-%m-%d %H:%M}")
        else:
            if db.get(Workspace, args.src) is None or db.get(Workspace, args.dst) is None:
                raise SystemExit("Both workspace ids must exist (see `list`).")
            moved = db.query(Business).filter(Business.user_id == args.src).update({Business.user_id: args.dst})
            db.commit()
            print(f"Moved {moved} business(es) from workspace {args.src} to workspace {args.dst}.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
