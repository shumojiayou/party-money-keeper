from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ROOM_CODE_DIGITS = "0123456789"
ROOM_CODE_LENGTH = 3
DEFAULT_GAME_NAME = "大富翁"
MAX_NAME_LENGTH = 20
MAX_ROOM_NAME_LENGTH = 32
MAX_NOTE_LENGTH = 60
MAX_AMOUNT = 1_000_000_000
RECENT_TRANSACTION_LIMIT = 30
WRITE_LOCK = threading.Lock()


@dataclass(frozen=True)
class DatabaseSettings:
    backend: str
    database_url: str | None
    sqlite_path: Path


def resolve_database_settings() -> DatabaseSettings:
    raw_url = os.environ.get("DATABASE_URL", "").strip()
    sqlite_path = Path(os.environ.get("DATABASE_PATH", BASE_DIR / "game.db")).resolve()

    if not raw_url:
        return DatabaseSettings(backend="sqlite", database_url=None, sqlite_path=sqlite_path)

    if raw_url.startswith("postgres://"):
        raw_url = "postgresql://" + raw_url[len("postgres://") :]

    if not raw_url.startswith("postgresql://"):
        raise ValueError("DATABASE_URL 目前只支持 PostgreSQL 连接串。")

    return DatabaseSettings(backend="postgres", database_url=raw_url, sqlite_path=sqlite_path)


DB_SETTINGS = resolve_database_settings()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_name(raw: object, *, field_name: str, max_length: int) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError(f"{field_name}不能为空。")
    if len(value) > max_length:
        raise ValueError(f"{field_name}不能超过{max_length}个字符。")
    return value


def normalize_optional_name(raw: object, *, max_length: int, fallback: str) -> str:
    value = str(raw or "").strip() or fallback
    if len(value) > max_length:
        raise ValueError(f"名称不能超过{max_length}个字符。")
    return value


def normalize_note(raw: object) -> str:
    value = str(raw or "").strip()
    if len(value) > MAX_NOTE_LENGTH:
        raise ValueError(f"备注不能超过{MAX_NOTE_LENGTH}个字符。")
    return value


def parse_amount(raw: object, *, field_name: str, minimum: int = 1) -> int:
    try:
        amount = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{field_name}必须是有效数字。") from None

    if amount != amount.to_integral_value():
        raise ValueError(f"{field_name}必须是整数。")

    value = int(amount)
    if value < minimum:
        raise ValueError(f"{field_name}必须大于等于{minimum}。")
    if value > MAX_AMOUNT:
        raise ValueError(f"{field_name}不能超过{MAX_AMOUNT}。")
    return value


def sqlite_schema() -> str:
    return """
    CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        starting_balance INTEGER NOT NULL,
        bank_balance INTEGER NOT NULL DEFAULT 0,
        host_player_id INTEGER,
        bank_admin_player_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        balance INTEGER NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        actor_player_id INTEGER NOT NULL,
        from_kind TEXT NOT NULL CHECK (from_kind IN ('player', 'bank')),
        from_player_id INTEGER,
        to_kind TEXT NOT NULL CHECK (to_kind = 'player'),
        to_player_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY(actor_player_id) REFERENCES players(id),
        FOREIGN KEY(from_player_id) REFERENCES players(id),
        FOREIGN KEY(to_player_id) REFERENCES players(id)
    );

    CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_room ON transactions(room_id, id DESC);
    """


def postgres_schema() -> str:
    return """
    CREATE TABLE IF NOT EXISTS rooms (
        id BIGSERIAL PRIMARY KEY,
        room_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        starting_balance BIGINT NOT NULL,
        bank_balance BIGINT NOT NULL DEFAULT 0,
        host_player_id BIGINT,
        bank_admin_player_id BIGINT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
        id BIGSERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        balance BIGINT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        actor_player_id BIGINT NOT NULL REFERENCES players(id),
        from_kind TEXT NOT NULL CHECK (from_kind IN ('player', 'bank')),
        from_player_id BIGINT REFERENCES players(id),
        to_kind TEXT NOT NULL CHECK (to_kind = 'player'),
        to_player_id BIGINT NOT NULL REFERENCES players(id),
        amount BIGINT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_room ON transactions(room_id, id DESC);
    """


def normalize_row(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return dict(row)
    if isinstance(row, dict):
        return row
    mapping = getattr(row, "_mapping", None)
    if mapping is not None:
        return dict(mapping)
    return dict(row)


class QueryResult:
    def __init__(self, cursor: Any) -> None:
        self.cursor = cursor
        self.lastrowid = getattr(cursor, "lastrowid", None)

    def fetchone(self) -> dict[str, Any] | None:
        return normalize_row(self.cursor.fetchone())

    def fetchall(self) -> list[dict[str, Any]]:
        return [normalize_row(row) for row in self.cursor.fetchall() if row is not None]


class DatabaseConnection:
    def __init__(self, backend: str, raw_connection: Any) -> None:
        self.backend = backend
        self.raw_connection = raw_connection

    def __enter__(self) -> "DatabaseConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()

    def _compile_query(self, query: str) -> str:
        if self.backend == "postgres":
            return query.replace("?", "%s")
        return query

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> QueryResult:
        cursor = self.raw_connection.execute(self._compile_query(query), params)
        return QueryResult(cursor)

    def execute_script(self, script: str) -> None:
        if self.backend == "sqlite":
            self.raw_connection.executescript(script)
            return

        statements = [statement.strip() for statement in script.split(";") if statement.strip()]
        for statement in statements:
            self.raw_connection.execute(statement)

    def begin(self) -> None:
        if self.backend == "sqlite":
            self.raw_connection.execute("BEGIN IMMEDIATE")
        else:
            self.raw_connection.execute("BEGIN")

    def commit(self) -> None:
        self.raw_connection.commit()

    def rollback(self) -> None:
        self.raw_connection.rollback()

    def close(self) -> None:
        self.raw_connection.close()


class GameStore:
    def __init__(self, settings: DatabaseSettings) -> None:
        self.settings = settings

    @property
    def backend_label(self) -> str:
        return self.settings.backend

    def connect(self) -> DatabaseConnection:
        if self.settings.backend == "sqlite":
            conn = sqlite3.connect(self.settings.sqlite_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            return DatabaseConnection("sqlite", conn)

        if psycopg is None or dict_row is None:
            raise RuntimeError("当前环境缺少 psycopg，无法连接 PostgreSQL。")

        conn = psycopg.connect(self.settings.database_url, row_factory=dict_row)
        return DatabaseConnection("postgres", conn)

    def init_db(self) -> None:
        schema = postgres_schema() if self.settings.backend == "postgres" else sqlite_schema()
        with self.connect() as conn:
            conn.execute_script(schema)

    def _insert_and_get_id(
        self,
        conn: DatabaseConnection,
        query: str,
        params: tuple[Any, ...],
    ) -> int:
        if conn.backend == "postgres":
            returning_query = f"{query.rstrip().rstrip(';')} RETURNING id"
            row = conn.execute(returning_query, params).fetchone()
            if not row:
                raise RuntimeError("插入记录后未返回主键。")
            return int(row["id"])

        cursor = conn.execute(query, params)
        if cursor.lastrowid is None:
            raise RuntimeError("SQLite 未返回主键。")
        return int(cursor.lastrowid)

    def _generate_room_code(self, conn: DatabaseConnection) -> str:
        for _ in range(2000):
            code = "".join(secrets.choice(ROOM_CODE_DIGITS) for _ in range(ROOM_CODE_LENGTH))
            exists = conn.execute(
                "SELECT 1 FROM rooms WHERE room_code = ?",
                (code,),
            ).fetchone()
            if not exists:
                return code
        raise RuntimeError("房间数量已满，请稍后再试。")

    def _load_authenticated_room(
        self,
        conn: DatabaseConnection,
        room_code: str,
        player_id: int,
        token: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        room = conn.execute(
            "SELECT * FROM rooms WHERE room_code = ?",
            (room_code,),
        ).fetchone()
        if not room:
            raise LookupError("房间不存在。")

        player = conn.execute(
            "SELECT * FROM players WHERE id = ? AND room_id = ? AND token = ?",
            (player_id, room["id"], token),
        ).fetchone()
        if not player:
            raise PermissionError("登录已失效，请重新加入房间。")

        return room, player

    def _player_exists(self, conn: DatabaseConnection, room_id: int, player_id: int) -> dict[str, Any]:
        player = conn.execute(
            "SELECT * FROM players WHERE id = ? AND room_id = ?",
            (player_id, room_id),
        ).fetchone()
        if not player:
            raise LookupError("目标玩家不存在。")
        return player

    def _room_snapshot(
        self,
        conn: DatabaseConnection,
        room: dict[str, Any],
        me: dict[str, Any],
    ) -> dict[str, object]:
        player_rows = conn.execute(
            """
            SELECT id, name, balance, created_at
            FROM players
            WHERE room_id = ?
            ORDER BY balance DESC, created_at ASC, id ASC
            """,
            (room["id"],),
        ).fetchall()

        players: list[dict[str, object]] = []
        total_assets = 0
        my_rank = 0

        for index, row in enumerate(player_rows, start=1):
            is_host = row["id"] == room["host_player_id"]
            is_bank_admin = row["id"] == room["bank_admin_player_id"]
            total_assets += int(row["balance"])
            if row["id"] == me["id"]:
                my_rank = index
            players.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "balance": row["balance"],
                    "isHost": is_host,
                    "isBankAdmin": is_bank_admin,
                }
            )

        tx_rows = conn.execute(
            """
            SELECT
                t.id,
                t.amount,
                t.note,
                t.created_at,
                actor.name AS actor_name,
                source.name AS from_player_name,
                dest.name AS to_player_name,
                t.from_kind
            FROM transactions t
            JOIN players actor ON actor.id = t.actor_player_id
            LEFT JOIN players source ON source.id = t.from_player_id
            JOIN players dest ON dest.id = t.to_player_id
            WHERE t.room_id = ?
            ORDER BY t.id DESC
            LIMIT ?
            """,
            (room["id"], RECENT_TRANSACTION_LIMIT),
        ).fetchall()

        transactions: list[dict[str, object]] = []
        for row in tx_rows:
            from_label = "银行" if row["from_kind"] == "bank" else row["from_player_name"]
            transactions.append(
                {
                    "id": row["id"],
                    "amount": row["amount"],
                    "note": row["note"],
                    "createdAt": row["created_at"],
                    "actorName": row["actor_name"],
                    "fromLabel": from_label,
                    "toLabel": row["to_player_name"],
                }
            )

        return {
            "room": {
                "name": room["name"],
                "code": room["room_code"],
                "startingBalance": room["starting_balance"],
                "createdAt": room["created_at"],
                "updatedAt": room["updated_at"],
            },
            "me": {
                "id": me["id"],
                "name": me["name"],
                "balance": me["balance"],
                "rank": my_rank,
                "isHost": me["id"] == room["host_player_id"],
                "isBankAdmin": me["id"] == room["bank_admin_player_id"],
            },
            "stats": {
                "playerCount": len(players),
                "totalPlayerAssets": total_assets,
            },
            "players": players,
            "transactions": transactions,
            "bankAdminPlayerId": room["bank_admin_player_id"],
            "hostPlayerId": room["host_player_id"],
            "serverTime": now_iso(),
        }

    def create_room(
        self,
        *,
        room_name: object,
        player_name: object,
        starting_balance: object,
        bank_balance: object,
    ) -> dict[str, object]:
        del bank_balance
        safe_room_name = normalize_optional_name(
            room_name,
            max_length=MAX_ROOM_NAME_LENGTH,
            fallback=DEFAULT_GAME_NAME,
        )
        safe_player_name = normalize_name(
            player_name,
            field_name="玩家名",
            max_length=MAX_NAME_LENGTH,
        )
        safe_starting_balance = parse_amount(
            starting_balance,
            field_name="玩家初始资金",
            minimum=0,
        )

        with WRITE_LOCK:
            conn = self.connect()
            try:
                conn.begin()
                created_at = now_iso()
                room_code = self._generate_room_code(conn)
                room_id = self._insert_and_get_id(
                    conn,
                    """
                    INSERT INTO rooms (
                        room_code,
                        name,
                        starting_balance,
                        bank_balance,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        room_code,
                        safe_room_name,
                        safe_starting_balance,
                        0,
                        created_at,
                        created_at,
                    ),
                )

                token = secrets.token_urlsafe(24)
                player_id = self._insert_and_get_id(
                    conn,
                    """
                    INSERT INTO players (
                        room_id,
                        name,
                        balance,
                        token,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        room_id,
                        safe_player_name,
                        safe_starting_balance,
                        token,
                        created_at,
                        created_at,
                    ),
                )

                conn.execute(
                    """
                    UPDATE rooms
                    SET host_player_id = ?,
                        bank_admin_player_id = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (player_id, player_id, created_at, room_id),
                )

                room = conn.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
                me = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
                snapshot = self._room_snapshot(conn, room, me)
                conn.commit()
                return {
                    "session": {
                        "roomCode": room_code,
                        "playerId": player_id,
                        "token": token,
                    },
                    "state": snapshot,
                }
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def join_room(self, *, room_code: object, player_name: object) -> dict[str, object]:
        safe_room_code = str(room_code or "").strip()
        if len(safe_room_code) != ROOM_CODE_LENGTH or not safe_room_code.isdigit():
            raise ValueError("房间码应为 3 位数字。")

        safe_player_name = normalize_name(
            player_name,
            field_name="玩家名",
            max_length=MAX_NAME_LENGTH,
        )

        with WRITE_LOCK:
            conn = self.connect()
            try:
                conn.begin()
                room = conn.execute(
                    "SELECT * FROM rooms WHERE room_code = ?",
                    (safe_room_code,),
                ).fetchone()
                if not room:
                    raise LookupError("房间不存在。")

                duplicate = conn.execute(
                    """
                    SELECT 1
                    FROM players
                    WHERE room_id = ?
                      AND lower(name) = lower(?)
                    """,
                    (room["id"], safe_player_name),
                ).fetchone()
                if duplicate:
                    raise ValueError("房间里已经有同名玩家，请换个名字。")

                created_at = now_iso()
                token = secrets.token_urlsafe(24)
                player_id = self._insert_and_get_id(
                    conn,
                    """
                    INSERT INTO players (
                        room_id,
                        name,
                        balance,
                        token,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        room["id"],
                        safe_player_name,
                        room["starting_balance"],
                        token,
                        created_at,
                        created_at,
                    ),
                )

                conn.execute(
                    "UPDATE rooms SET updated_at = ? WHERE id = ?",
                    (created_at, room["id"]),
                )
                updated_room = conn.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
                me = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
                snapshot = self._room_snapshot(conn, updated_room, me)
                conn.commit()
                return {
                    "session": {
                        "roomCode": safe_room_code,
                        "playerId": player_id,
                        "token": token,
                    },
                    "state": snapshot,
                }
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def get_state(self, *, room_code: str, player_id: int, token: str) -> dict[str, object]:
        conn = self.connect()
        try:
            room, me = self._load_authenticated_room(
                conn,
                room_code=room_code,
                player_id=player_id,
                token=token,
            )
            return self._room_snapshot(conn, room, me)
        finally:
            conn.close()

    def assign_bank_admin(
        self,
        *,
        room_code: str,
        player_id: int,
        token: str,
        bank_admin_player_id: object,
    ) -> dict[str, object]:
        target_player_id = parse_amount(
            bank_admin_player_id,
            field_name="银行管理员",
            minimum=1,
        )

        with WRITE_LOCK:
            conn = self.connect()
            try:
                conn.begin()
                room, me = self._load_authenticated_room(
                    conn,
                    room_code=room_code,
                    player_id=player_id,
                    token=token,
                )
                if me["id"] != room["host_player_id"]:
                    raise PermissionError("只有房主可以更换银行管理员。")
                self._player_exists(conn, room["id"], target_player_id)

                updated_at = now_iso()
                conn.execute(
                    """
                    UPDATE rooms
                    SET bank_admin_player_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (target_player_id, updated_at, room["id"]),
                )
                updated_room = conn.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
                updated_me = conn.execute("SELECT * FROM players WHERE id = ?", (me["id"],)).fetchone()
                snapshot = self._room_snapshot(conn, updated_room, updated_me)
                conn.commit()
                return {"state": snapshot}
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def transfer(
        self,
        *,
        room_code: str,
        player_id: int,
        token: str,
        from_kind: object,
        to_kind: object,
        to_player_id: object,
        amount: object,
        note: object,
    ) -> dict[str, object]:
        safe_from_kind = str(from_kind or "").strip()
        safe_to_kind = str(to_kind or "").strip()
        if safe_from_kind not in {"player", "bank"}:
            raise ValueError("来源类型不正确。")
        if safe_to_kind != "player":
            raise ValueError("现在只支持转给玩家。")

        safe_amount = parse_amount(amount, field_name="金额", minimum=1)
        safe_note = normalize_note(note)
        target_player_id = parse_amount(to_player_id, field_name="目标玩家", minimum=1)

        with WRITE_LOCK:
            conn = self.connect()
            try:
                conn.begin()
                room, me = self._load_authenticated_room(
                    conn,
                    room_code=room_code,
                    player_id=player_id,
                    token=token,
                )

                target_player = self._player_exists(conn, room["id"], target_player_id)
                if target_player["id"] == me["id"]:
                    raise ValueError("不能给自己转账。")

                updated_at = now_iso()
                from_player_id: int | None = None

                if safe_from_kind == "player":
                    if me["balance"] < safe_amount:
                        raise ValueError("你的余额不足。")
                    from_player_id = me["id"]
                    conn.execute(
                        "UPDATE players SET balance = balance - ?, updated_at = ? WHERE id = ?",
                        (safe_amount, updated_at, me["id"]),
                    )
                elif me["id"] != room["bank_admin_player_id"]:
                    raise PermissionError("只有银行管理员可以从银行出款。")

                conn.execute(
                    "UPDATE players SET balance = balance + ?, updated_at = ? WHERE id = ?",
                    (safe_amount, updated_at, target_player["id"]),
                )

                conn.execute(
                    """
                    INSERT INTO transactions (
                        room_id,
                        actor_player_id,
                        from_kind,
                        from_player_id,
                        to_kind,
                        to_player_id,
                        amount,
                        note,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        room["id"],
                        me["id"],
                        safe_from_kind,
                        from_player_id,
                        "player",
                        target_player["id"],
                        safe_amount,
                        safe_note,
                        updated_at,
                    ),
                )

                updated_room = conn.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
                updated_me = conn.execute("SELECT * FROM players WHERE id = ?", (me["id"],)).fetchone()
                snapshot = self._room_snapshot(conn, updated_room, updated_me)
                conn.commit()
                return {"state": snapshot}
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()


class AppHandler(BaseHTTPRequestHandler):
    store = GameStore(DB_SETTINGS)

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _read_json_body(self) -> dict[str, object]:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            raise ValueError("请求体不是合法 JSON。") from None

    def _parse_route(self) -> tuple[list[str], dict[str, list[str]]]:
        parsed = urlparse(self.path)
        parts = [segment for segment in parsed.path.split("/") if segment]
        return parts, parse_qs(parsed.query)

    def do_GET(self) -> None:
        parts, query = self._parse_route()

        if parts == ["api", "health"]:
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "time": now_iso(),
                    "databaseBackend": self.store.backend_label,
                },
            )
            return

        if len(parts) == 4 and parts[0] == "api" and parts[1] == "rooms" and parts[3] == "state":
            room_code = parts[2]
            try:
                player_id = parse_amount(
                    (query.get("playerId") or [""])[0],
                    field_name="玩家 ID",
                    minimum=1,
                )
                token = (query.get("token") or [""])[0]
                if not token:
                    raise ValueError("缺少登录令牌。")
                state = self.store.get_state(
                    room_code=room_code,
                    player_id=player_id,
                    token=token,
                )
                self._send_json(HTTPStatus.OK, {"state": state})
                return
            except ValueError as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
            except LookupError as exc:
                self._send_error(HTTPStatus.NOT_FOUND, str(exc))
                return
            except PermissionError as exc:
                self._send_error(HTTPStatus.FORBIDDEN, str(exc))
                return

        self._serve_static(parts)

    def do_POST(self) -> None:
        parts, _query = self._parse_route()
        try:
            payload = self._read_json_body()
        except ValueError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
            return

        try:
            if parts == ["api", "rooms", "create"]:
                response = self.store.create_room(
                    room_name=payload.get("roomName"),
                    player_name=payload.get("playerName"),
                    starting_balance=payload.get("startingBalance"),
                    bank_balance=payload.get("bankBalance"),
                )
                self._send_json(HTTPStatus.CREATED, response)
                return

            if parts == ["api", "rooms", "join"]:
                response = self.store.join_room(
                    room_code=payload.get("roomCode"),
                    player_name=payload.get("playerName"),
                )
                self._send_json(HTTPStatus.CREATED, response)
                return

            if len(parts) == 4 and parts[0] == "api" and parts[1] == "rooms" and parts[3] == "transfer":
                player_id = parse_amount(payload.get("playerId"), field_name="玩家 ID", minimum=1)
                token = str(payload.get("token") or "")
                if not token:
                    raise ValueError("缺少登录令牌。")
                response = self.store.transfer(
                    room_code=parts[2],
                    player_id=player_id,
                    token=token,
                    from_kind=payload.get("fromKind"),
                    to_kind=payload.get("toKind"),
                    to_player_id=payload.get("toPlayerId"),
                    amount=payload.get("amount"),
                    note=payload.get("note"),
                )
                self._send_json(HTTPStatus.OK, response)
                return

            if len(parts) == 4 and parts[0] == "api" and parts[1] == "rooms" and parts[3] == "bank-admin":
                player_id = parse_amount(payload.get("playerId"), field_name="玩家 ID", minimum=1)
                token = str(payload.get("token") or "")
                if not token:
                    raise ValueError("缺少登录令牌。")
                response = self.store.assign_bank_admin(
                    room_code=parts[2],
                    player_id=player_id,
                    token=token,
                    bank_admin_player_id=payload.get("bankAdminPlayerId"),
                )
                self._send_json(HTTPStatus.OK, response)
                return

            self._send_error(HTTPStatus.NOT_FOUND, "接口不存在。")
        except ValueError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
        except LookupError as exc:
            self._send_error(HTTPStatus.NOT_FOUND, str(exc))
        except PermissionError as exc:
            self._send_error(HTTPStatus.FORBIDDEN, str(exc))

    def _serve_static(self, parts: list[str]) -> None:
        if not parts:
            file_path = STATIC_DIR / "index.html"
        else:
            candidate = (STATIC_DIR / "/".join(parts)).resolve()
            try:
                candidate.relative_to(STATIC_DIR.resolve())
            except ValueError:
                self._send_error(HTTPStatus.NOT_FOUND, "文件不存在。")
                return
            file_path = candidate

        if not file_path.exists() or not file_path.is_file():
            self._send_error(HTTPStatus.NOT_FOUND, "文件不存在。")
            return

        content_type, _ = mimetypes.guess_type(str(file_path))
        body = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="聚餐游戏助手 H5 服务")
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "0.0.0.0"),
        help="监听地址，云端一般保持 0.0.0.0",
    )
    parser.add_argument(
        "--port",
        default=int(os.environ.get("PORT", "8000")),
        type=int,
        help="监听端口，云平台通常会自动注入 PORT",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    AppHandler.store.init_db()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(
        f"聚餐游戏助手已启动：http://{args.host}:{args.port} "
        f"(database={AppHandler.store.backend_label})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
