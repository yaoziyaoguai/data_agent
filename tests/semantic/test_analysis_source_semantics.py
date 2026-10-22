"""用独立输入核对语义前提；反例和预期不进入模型知识目录。"""
from pathlib import Path
import sqlite3
import unittest


SOURCES = Path(__file__).resolve().parents[2] / "docs/sources"


class SourceSemanticsTests(unittest.TestCase):
    def database(self, source):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript((source / "schema.sql").read_text())
        for line, state in [(1, "cancelled"), (2, "placed")]:
            connection.execute(
                "INSERT INTO raw_order_lines VALUES (?, ?, NULL, ?, 1, ?, 'web', 0, ?)",
                ("independent-order", line, f"product-{line}", "2026-01-01T00:00:00Z", state),
            )
            connection.execute(
                "INSERT INTO raw_payments VALUES (?, ?, ?, 'charge', ?, ?, 'success')",
                (f"charge-{line}", "independent-order", line, 100 * line,
                 "2026-01-02T00:00:00Z"),
            )
        connection.commit()
        return connection

    def test_line_cancellation_can_differ_within_the_same_order(self):
        for source in [SOURCES, SOURCES / "analysis"]:
            with self.subTest(source=source.name):
                connection = self.database(source)
                connection.executescript((source / "etl.sql").read_text())
                rows = connection.execute(
                    "SELECT line_id, order_status, paid_amount_cents, paid_at "
                    "FROM demo_order_detail ORDER BY line_id"
                ).fetchall()
                self.assertEqual(rows, [
                    (1, "cancelled", 100, "2026-01-02T00:00:00Z"),
                    (2, "paid", 200, "2026-01-02T00:00:00Z"),
                ])

    def test_failed_insert_requires_explicit_rollback_to_restore_deleted_rows(self):
        for source in [SOURCES, SOURCES / "analysis"]:
            with self.subTest(source=source.name):
                connection = self.database(source)
                etl = (source / "etl.sql").read_text()
                connection.executescript(etl)
                before = connection.execute(
                    "SELECT * FROM demo_order_detail ORDER BY line_id"
                ).fetchall()
                connection.execute(
                    "INSERT INTO raw_payments VALUES "
                    "('over-refund', 'independent-order', 2, 'refund', 201, "
                    "'2026-01-03T00:00:00Z', 'success')"
                )
                connection.commit()
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.executescript(etl)
                self.assertTrue(connection.in_transaction)
                self.assertEqual(connection.execute("SELECT * FROM demo_order_detail").fetchall(), [])
                connection.rollback()
                self.assertEqual(connection.execute(
                    "SELECT * FROM demo_order_detail ORDER BY line_id"
                ).fetchall(), before)

    def test_payment_events_do_not_supply_order_test_flag_or_payment_event_type(self):
        connection = self.database(SOURCES / "analysis")
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such column: is_test"):
            connection.execute("SELECT * FROM raw_payments WHERE is_test = 0")
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO raw_payments VALUES "
                "('unsupported', 'independent-order', 1, 'payment', 1, "
                "'2026-01-03T00:00:00Z', 'success')"
            )


if __name__ == "__main__":
    unittest.main()
