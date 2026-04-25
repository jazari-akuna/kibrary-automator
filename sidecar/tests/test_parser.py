from kibrary_sidecar.parser import parse_input

def test_single_line_list_with_qtys_treated_as_list_of_lcscs():
    r = parse_input("C123, C456, C789")
    assert r["format"] == "list"
    assert [(x["lcsc"], x["qty"], x["ok"]) for x in r["rows"]] == [
        ("C123", 1, True), ("C456", 1, True), ("C789", 1, True),
    ]

def test_bom_two_lines_qty_per_line():
    r = parse_input("C123, 2\nC456, 5")
    assert r["format"] == "bom"
    assert [(x["lcsc"], x["qty"], x["ok"]) for x in r["rows"]] == [
        ("C123", 2, True), ("C456", 5, True),
    ]

def test_strict_csv_one_line_still_bom():
    r = parse_input("C999, 7")
    assert r["format"] == "bom"
    assert r["rows"] == [{"lcsc": "C999", "qty": 7, "ok": True, "error": None}]

def test_invalid_token_marked_not_ok():
    r = parse_input("C123, banana")
    assert r["format"] == "list"
    assert r["rows"][0]["ok"] is True
    assert r["rows"][1]["ok"] is False

def test_comments_and_blank_lines_ignored():
    r = parse_input("# header\n\nC1\nC2\n")
    assert [x["lcsc"] for x in r["rows"]] == ["C1", "C2"]

def test_whitespace_tolerant():
    r = parse_input("  C1 ,  3  \n  C2 , 4 ")
    assert r["rows"] == [
        {"lcsc": "C1", "qty": 3, "ok": True, "error": None},
        {"lcsc": "C2", "qty": 4, "ok": True, "error": None},
    ]
