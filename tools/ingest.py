"""
감시 폴더(유니티 프로젝트의 Assets/ 같은 '풀린' 에셋 폴더)를 스캔해서
catalog 에 없는 FBX / 내용이 바뀐 FBX 만 추가하고, 폴더에서 사라진 FBX 는 catalog 에서 뺀다.
머티리얼/텍스처 해석은 extract.py 의 로직을 그대로 쓴다 (.meta 의 GUID 기준).

usage: python tools/ingest.py [폴더]      (기본: 프로젝트의 incoming/)
stdout 마지막 줄: {"added": [...], "updated": [...], "removed": [...]}
"""
import hashlib, json, os, re, shutil, sys
from datetime import datetime

from extract import (CATALOG, LIB, OUT, SKIP_PATH, TEX_EXT, resolve_materials, save_texture)

WATCH = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WATCH_DIR", os.path.join(OUT, "incoming")))
PACK = "incoming"


def index_folder(root):
    """extract.index_package 와 같은 모양의 인덱스를 폴더에서 만든다: guid -> {path, meta, size, text, abs}"""
    idx = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.endswith(".meta"):
                continue
            ab = os.path.join(dp, f)
            rel = os.path.relpath(ab, root).replace(os.sep, "/")
            meta = ""
            if os.path.exists(ab + ".meta"):
                meta = open(ab + ".meta", encoding="utf-8", errors="ignore").read()
            m = re.search(r"^guid: (\w+)", meta, re.M)
            guid = m.group(1) if m else hashlib.md5(rel.encode()).hexdigest()
            size = os.path.getsize(ab)
            text = None
            if f.lower().endswith((".mat", ".prefab")) and size < 3_000_000:
                text = open(ab, encoding="utf-8", errors="ignore").read()
            idx[guid] = {"path": rel, "meta": meta, "size": size, "text": text, "abs": ab}
    return idx


def file_hash(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    os.makedirs(WATCH, exist_ok=True)
    catalog = json.load(open(CATALOG, encoding="utf-8")) if os.path.exists(CATALOG) else []
    mine = {e["sourcePath"]: e for e in catalog if e.get("origin") == "watch"}

    idx = index_folder(WATCH)
    prefab_refs = {}
    for g, e in idx.items():
        if e["text"] and e["path"].endswith(".prefab"):
            for ref in set(re.findall(r"guid: (\w{32})", e["text"])):
                prefab_refs.setdefault(ref, []).append(g)

    fbx = {g: e for g, e in idx.items()
           if e["path"].lower().endswith(".fbx") and not SKIP_PATH.search(e["path"]) and e["size"] >= 2000}
    seen, added, updated = set(), [], []
    tdir = os.path.join(LIB, PACK, "tex")
    os.makedirs(tdir, exist_ok=True)

    for g, e in fbx.items():
        rel = e["path"]
        seen.add(rel)
        h = file_hash(e["abs"])
        old = mine.get(rel)
        if old and old.get("hash") == h:
            continue  # 그대로 → 아무것도 안 함 (API 호출도 없음)

        by_name, ordered = resolve_materials(g, idx, prefab_refs, {})

        def slot(mi):
            tex = None
            if mi["tex"] and mi["tex"] in idx and idx[mi["tex"]]["path"].lower().endswith(TEX_EXT):
                try:
                    raw = open(idx[mi["tex"]]["abs"], "rb").read()
                    tex = f"library/{PACK}/tex/{save_texture(raw, idx[mi['tex']]['path'], tdir)}"
                except Exception as ex:
                    print("texture fail", idx[mi["tex"]]["path"], ex, file=sys.stderr)
            return {"mat": mi["name"], "color": mi["color"], "tex": tex}

        dst_rel = f"library/{PACK}/{rel}"
        os.makedirs(os.path.dirname(os.path.join(OUT, dst_rel)), exist_ok=True)
        shutil.copyfile(e["abs"], os.path.join(OUT, dst_rel))
        parts = rel.split("/")
        entry = {
            "id": f"{PACK}/{os.path.splitext(rel)[0]}",
            "name": os.path.splitext(os.path.basename(rel))[0],
            "pack": parts[1] if parts[0] == "Assets" and len(parts) > 2 else (parts[0] if len(parts) > 1 else PACK),
            "category": PACK,
            "file": dst_rel,
            "sourcePath": rel,
            "sizeKB": round(e["size"] / 1024),
            "materials": {"byName": {k: slot(v) for k, v in by_name.items()}, "ordered": [slot(v) for v in ordered]},
            "origin": "watch",
            "hash": h,
            "addedAt": datetime.now().isoformat(timespec="seconds"),
        }
        if old:
            catalog.remove(old)
            updated.append(entry["id"])
        else:
            added.append(entry["id"])
        catalog.append(entry)

    removed = [e["id"] for rel, e in mine.items() if rel not in seen]
    catalog = [e for e in catalog if not (e.get("origin") == "watch" and e["sourcePath"] not in seen)]

    if added or updated or removed:
        tmp = CATALOG + ".tmp"
        json.dump(catalog, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, CATALOG)
    print(json.dumps({"added": added, "updated": updated, "removed": removed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
