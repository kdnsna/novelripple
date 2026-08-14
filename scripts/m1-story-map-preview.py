#!/usr/bin/env python3
"""M1-07 Story Map 人工标注预审：从最新 M1-06 评测库读确认版 story map，
对照 manifest Gold 做人物/事件/Ending 初步一对一匹配，输出 story-map.json 草稿。
注意：本脚本只做机器辅助预匹配，最终标注需人工复核（大爷）。"""
import json, sqlite3, sys, re
import hashlib

REPO = "/Users/kdnsna/Projects/06-项目代码/novelripple"
RUN_DIR = ".data/evals/m1-continuation/20260814054950374-868249c-d3abd3fd"
DB = f"{REPO}/{RUN_DIR}/eval.db"
STORY_IDS = {
    "A": ("m1-a-zhuanzhengqi", "转正期"),
    "B": ("m1-b-chunsheng", "春生"),
    "C": ("m1-c-wudu", "雾渡"),
}

def norm(s):
    return re.sub(r"[\s，。、；：！？（）《》\"'“”‘’·\-—…]", "", s or "")

def char_key(name):
    """人物匹配键：全名或前两个字符（姓+名首字）"""
    n = norm(name)
    return n if len(n) >= 2 else n

db = sqlite3.connect(DB)
out = []

for cls, (sid, title) in STORY_IDS.items():
    manifest = json.load(open(f"{REPO}/benchmarks/private/{sid}/manifest.json"))
    gold_chars = manifest.get("expectedCoreCharacters", [])
    gold_events = manifest.get("expectedKeyEvents", [])
    gold_endings = manifest.get("expectedEndingCandidates", [])

    # 确认版 story map（该 source 下 status=confirmed 的最高 version）
    manifest_raw = manifest
    source_path = manifest_raw.get("sourcePath")
    content_hash = None
    if source_path:
        try:
            raw = open(f"{REPO}/benchmarks/private/{sid}/{source_path}", "rb").read()
            content_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
        except OSError:
            pass
    if content_hash:
        row = db.execute(
            "SELECT id FROM sources WHERE content_hash = ?", (content_hash,)
        ).fetchone()
    else:
        row = None
    if not row:
        # 找不到 source 时用全库 confirmed 里人物数最接近的
        print(f"Story {cls}: 未按 contentHash 找到 source，尝试 title 匹配")
        row = db.execute(
            "SELECT id FROM sources WHERE title LIKE ? LIMIT 1", (f"%{title}%",)
        ).fetchone()
    if not row:
        print(f"Story {cls}: 找不到 source！")
        continue
    source_id = row[0]
    rows = db.execute(
        "SELECT id, version, data_json FROM artifacts WHERE source_id = ? AND kind='story_map_revision' ORDER BY version DESC",
        (source_id,),
    ).fetchall()
    confirmed = None
    for aid, ver, data in rows:
        sm = json.loads(data)
        if sm.get("status") == "confirmed":
            confirmed = sm
            break

    cand_chars = confirmed.get("characters", [])
    cand_events = confirmed.get("events", [])
    cand_endings = confirmed.get("endingCandidates", [])

    # ── 人物匹配 ──
    cand_names = [norm(c.get("name", "")) for c in cand_chars]
    matched_chars = []
    for g in gold_chars:
        gname = g.get("name", "") if isinstance(g, dict) else str(g)
        gkey = char_key(gname)
        hit = None
        for c in cand_chars:
            cname = norm(c.get("name", ""))
            aliases = [norm(a) for a in c.get("aliases", [])]
            if gkey and (gkey == cname or any(gkey == a for a in aliases) or cname.startswith(gkey) or gkey.startswith(cname)):
                hit = c
                break
        matched_chars.append({"gold": gname, "matched": bool(hit), "candidate": hit.get("name") if hit else None})

    # ── 事件匹配（关键词重叠 + 复核队列）──
    def ev_key(e):
        t = norm(e.get("title", ""))
        s = norm(e.get("summary", ""))
        return t, s

    matched_events = []
    unmatched_candidates = []
    used = set()
    for g in gold_events:
        gtitle = g.get("label", "") if isinstance(g, dict) else str(g)
        gsum = ""
        gk = norm(gtitle)
        gk_set = set(gk)
        best, best_score = None, 0
        for i, c in enumerate(cand_events):
            if i in used:
                continue
            ct, cs = ev_key(c)
            ck = norm(ct + cs)
            ck_set = set(ck)
            # gold label 字符被 candidate 文本覆盖的比例 + Jaccard 混合
            coverage = len(gk_set & ck_set) / max(len(gk_set), 1)
            jaccard = len(gk_set & ck_set) / max(len(gk_set | ck_set), 1)
            score = 0.7 * coverage + 0.3 * jaccard
            if score > best_score:
                best, best_score = i, score
        hit = best_score >= 0.35
        if hit:
            used.add(best)
            matched_events.append({"gold": gtitle, "matched": True, "candidate": cand_events[best].get("title"), "score": round(best_score, 2)})
        else:
            matched_events.append({"gold": gtitle, "matched": False, "candidate": None, "score": round(best_score, 2)})
    for i, c in enumerate(cand_events):
        if i not in used:
            unmatched_candidates.append(c.get("title"))

    # ── Ending 匹配（gold label vs candidate requirement）──
    matched_endings = []
    for g in gold_endings:
        glabel = g.get("label", "") if isinstance(g, dict) else str(g)
        gk = norm(glabel)
        gk_set = set(gk)
        best, best_score = None, 0
        for i, e in enumerate(cand_endings):
            ck = norm(e.get("requirement", ""))
            ck_set = set(ck)
            coverage = len(gk_set & ck_set) / max(len(gk_set), 1)
            jaccard = len(gk_set & ck_set) / max(len(gk_set | ck_set), 1)
            score = 0.7 * coverage + 0.3 * jaccard
            if score > best_score:
                best, best_score = i, score
        hit = best_score >= 0.35
        matched_endings.append({
            "gold": glabel,
            "matched": bool(hit),
            "candidate": cand_endings[best].get("id") if hit else None,
            "score": round(best_score, 2),
        })

    # ── merge 检测：candidate 中是否有疑似把两个 gold 人物合成一个 ──
    merge_suspects = []
    for c in cand_chars:
        cname = norm(c.get("name", ""))
        hits = [g.get("name", "") if isinstance(g, dict) else str(g) for g in gold_chars
                if char_key(g.get("name", "") if isinstance(g, dict) else str(g)) and
                (cname.startswith(char_key(g.get("name", "") if isinstance(g, dict) else str(g))) or
                 char_key(g.get("name", "") if isinstance(g, dict) else str(g)).startswith(cname))]
        if len(set(hits)) > 1:
            merge_suspects.append({"candidate": c.get("name"), "goldHits": list(set(hits))})

    out.append({
        "storyClass": cls,
        "benchmarkId": sid,
        "characterCount": manifest.get("characterCount"),
        "coreCharacterRecall": sum(1 for m in matched_chars if m["matched"]) / max(len(matched_chars), 1),
        "coreCharacterTotal": len(matched_chars),
        "coreCharacterMatched": sum(1 for m in matched_chars if m["matched"]),
        "identityF1": None,  # 需人工确认候选 identity 全集后再算
        "keyEventRecall": sum(1 for m in matched_events if m["matched"]) / max(len(matched_events), 1),
        "keyEventTotal": len(matched_events),
        "keyEventMatched": sum(1 for m in matched_events if m["matched"]),
        "endingCandidateRecall": sum(1 for m in matched_endings if m["matched"]) / max(len(matched_endings), 1),
        "criticalMergeMistakes": len(merge_suspects),
        "causalEdgeApprovalRate": None,  # 人工逐条评审
        "evidenceValidityRate": None,  # 待自动校验
        "eventsWithoutValidEvidence": None,
        "notes": f"机器预匹配；待人工复核。人物明细={json.dumps(matched_chars, ensure_ascii=False)}；事件未匹配={[m['gold'] for m in matched_events if not m['matched']]}；候选未命中={unmatched_candidates}；ending未匹配={[m['gold'] for m in matched_endings if not m['matched']]}；merge疑似={json.dumps(merge_suspects, ensure_ascii=False)}",
    })
    print(f"Story {cls}: 人物 {sum(1 for m in matched_chars if m['matched'])}/{len(matched_chars)}"
          f" 事件 {sum(1 for m in matched_events if m['matched'])}/{len(matched_events)}"
          f" ending {sum(1 for m in matched_endings if m['matched'])}/{len(matched_endings)}"
          f" merge疑似 {len(merge_suspects)}")

json.dump(out, open(f"{REPO}/.data/m1-human/story-map-preview.json", "w"), ensure_ascii=False, indent=2)
print("\n预览写入 .data/m1-human/story-map-preview.json")
