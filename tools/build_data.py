"""source/*.txt (문항 원문) -> data/*.json 변환.

원문 형식:
#번호|정답
문제 (여러 줄 가능)
1) 보기1
2) 보기2
3) 보기3
4) 보기4
E: 해설 (다음 줄까지 이어짐)
S: 출처
N: 메모(선택)
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
AREAS = [
    # (id, 이름, 분류, 원문 파일)
    ("postal-transfer", "우편대체", "금융3급 _ 우편환대체_우편대체", "postal-transfer.txt"),
    ("insurance-practice", "보험실무", "금융3급 _ 금융실무_보험실무", "insurance-practice.txt"),
    ("insurance-system", "보험제도", "금융3급 _ 우체국보험_보험제도", "insurance-system.txt"),
    ("insurance-products", "보험상품", "금융3급 _ 우체국보험_보험상품", "insurance-products.txt"),
]
SOURCE_DOC = "2026년도 우정사업 직무인증평가 문제은행_2026.10.28. 현재"


def parse(text):
    out = []
    for block in re.split(r"\n(?=#\d+\|)", text.strip()):
        lines = block.strip().split("\n")
        m = re.match(r"#(\d+)\|(\d)", lines[0])
        no, ans = int(m.group(1)), int(m.group(2))
        q, choices, exp, src, note, mode = [], [], [], "", "", "q"
        for ln in lines[1:]:
            cm = re.match(r"([1-4])\) (.*)", ln)
            if mode in ("q", "c") and cm and int(cm.group(1)) == len(choices) + 1:
                choices.append(cm.group(2).strip()); mode = "c"; continue
            if ln.startswith("E:"):
                exp.append(ln[2:].strip()); mode = "e"; continue
            if ln.startswith("S:"):
                src = ln[2:].strip(); mode = "s"; continue
            if ln.startswith("N:"):
                note = ln[2:].strip(); mode = "n"; continue
            if mode == "q":
                q.append(ln.strip())
            elif mode == "e":
                exp.append(ln.strip())
            elif mode == "c" and ln.strip():
                choices[-1] += " " + ln.strip()
        assert len(choices) == 4, (no, choices)
        item = {"no": no, "q": "\n".join(q).strip(), "choices": choices, "answer": ans,
                "explanation": "\n".join(e for e in exp if e).strip(), "source": src}
        if note:
            item["answerNote"] = note
        out.append(item)
    nos = [x["no"] for x in out]
    assert nos == list(range(1, len(nos) + 1)), "문항 번호가 빠지거나 중복됨"
    return out


def main():
    index = json.loads((ROOT / "data/index.json").read_text(encoding="utf-8"))
    known = {a["id"] for a in index["areas"]}
    for aid, name, cat, fname in AREAS:
        qs = parse((ROOT / "source" / fname).read_text(encoding="utf-8"))
        data = {"id": aid, "name": name, "category": cat, "sourceDoc": SOURCE_DOC, "questions": qs}
        (ROOT / "data" / f"{aid}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if aid not in known:
            index["areas"].append({"id": aid, "file": f"data/{aid}.json"})
        print(f"{name}: {len(qs)}문항, 메모 {sum('answerNote' in q for q in qs)}건")
    (ROOT / "data/index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
