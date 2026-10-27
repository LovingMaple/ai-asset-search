"""
.unitypackage 에서 데모용 FBX + 텍스처를 골라 library/ 로 복사하고 data/catalog.json 을 만든다.
원본 패키지는 읽기만 한다.

usage: python tools/extract.py
"""
import collections, hashlib, io, json, os, random, re, sys, tarfile
from PIL import Image

ROOT = os.environ.get("UNITY_ASSET_ROOT", r"D:\유니티 에셋")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
LIB = os.path.join(OUT, "library")
CATALOG = os.path.join(OUT, "data", "catalog.json")
TEX_MAX = 1024
SEED = 42

# (패키지 파일명, 뽑을 개수)
PACKS = [
    ("POLYGON Knights - Low Poly 3D Art by Synty.unitypackage", 45),
    ("POLYGON Vikings - Low Poly 3D Art by Synty.unitypackage", 40),
    ("POLYGON Western - Low Poly 3D Art by Synty.unitypackage", 35),
    ("POLYGON Office - Low Poly 3D Art by Synty.unitypackage", 40),
    ("POLYGON Dungeons - Low Poly 3D Art by Synty.unitypackage", 40),
    ("Lowpoly Medieval Modular Armors Expansion Pack 01.unitypackage", 40),
    ("Lowpoly Medieval Peasants - Free pack.unitypackage", 20),
    ("Quirky Series - Animals Mega Pack Vol1.unitypackage", 35),
    ("Monsters Ultimate Pack 01 Cute Series.unitypackage", 30),
    ("Toy Pack - 230 Toys Objects - All In One Toy Mega Pack Low-Mid Poly.unitypackage", 35),
    ("Low Poly Cartoon House Interiors.unitypackage", 35),
    ("Sweets Pack - Low Poly Series.unitypackage", 15),
    ("Fast Food Pack - Low Poly Series.unitypackage", 15),
    ("Stylized RPG Starter Weapons.unitypackage", 13),
    ("Dungeon Props Pack 100 Objects.unitypackage", 30),
    ("Low Poly Musical Instruments.unitypackage", 20),
    ("Lowpoly Pack Sci-Fi Station.unitypackage", 25),
]

MODEL_EXT = (".fbx",)
TEX_EXT = (".png", ".jpg", ".jpeg", ".tga", ".psd", ".tif", ".tiff", ".bmp")
SKIP_PATH = re.compile(r"(/anim|animation|@|collider|_col\b|/demo|/scenes?/|_lod[1-9])", re.I)
MAIN_TEX_KEYS = ["_MainTex", "_BaseMap", "_BaseColorMap", "_Albedo", "_AlbedoMap", "_MainTexture",
                 "_Diffuse", "_DiffuseMap", "_BaseTexture", "_Texture"]
TEX_NAME_OK = re.compile(r"(base|albedo|diffuse|color|colour|_d\b|tex)", re.I)
TEX_NAME_BAD = re.compile(r"(normal|_n\b|nrm|mask|rough|metal|spec|emiss|_ao\b|occlusion|height|ramp)", re.I)


def slug(s):
    s = re.sub(r"\.unitypackage$", "", s)
    s = re.sub(r" - Low Poly 3D Art by Synty", "", s)
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")


def find_packages():
    found = {}
    for dp, _, fs in os.walk(ROOT):
        for f in fs:
            found.setdefault(f, os.path.join(dp, f))
    return found


def index_package(path):
    """pathname / meta / 작은 텍스트 에셋(.mat/.prefab)만 메모리에 올린다."""
    ents = collections.defaultdict(dict)
    with tarfile.open(path, "r:gz") as t:
        for m in t:
            if not m.isfile():
                continue
            g, _, kind = m.name.lstrip("./").partition("/")
            if kind in ("pathname", "asset.meta"):
                ents[g][kind] = t.extractfile(m).read().decode("utf-8", "ignore")
            elif kind == "asset":
                ents[g]["size"] = m.size
                ents[g]["_raw"] = (m.size < 3_000_000) and t.extractfile(m).read() or None
    out = {}
    for g, e in ents.items():
        if "pathname" not in e:
            continue
        p = e["pathname"].splitlines()[0].strip()
        low = p.lower()
        text = None
        if low.endswith((".mat", ".prefab")) and e.get("_raw"):
            text = e["_raw"].decode("utf-8", "ignore")
        out[g] = {"path": p, "meta": e.get("asset.meta", ""), "size": e.get("size", 0), "text": text}
    return out


def parse_mat(text):
    tex = {}
    for k, g in re.findall(r"- (_\w+):\s*\n\s*m_Texture: \{fileID: -?\d+, guid: (\w+)", text):
        tex[k] = g
    color = None
    m = re.search(r"- _(?:Base)?Color: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+)", text)
    if m:
        color = [round(float(x), 3) for x in m.groups()]
    return tex, color


def pick_main_tex(tex, idx):
    for k in MAIN_TEX_KEYS:
        if k in tex and tex[k] in idx:
            return tex[k]
    cands = [g for k, g in tex.items() if g in idx]
    named = [g for g in cands
             if TEX_NAME_OK.search(os.path.basename(idx[g]["path"])) and not TEX_NAME_BAD.search(os.path.basename(idx[g]["path"]))]
    if named:
        return named[0]
    clean = [g for g in cands if not TEX_NAME_BAD.search(os.path.basename(idx[g]["path"]))]
    return clean[0] if clean else None


def external_materials(meta):
    """FBX .meta 의 externalObjects: 머티리얼 이름 -> mat guid"""
    res = {}
    for name, g in re.findall(
            r"type: UnityEngine:Material\s*\n\s*assembly: [^\n]*\n\s*name: ([^\n]*)\n\s*second: \{fileID: \d+, guid: (\w+)", meta):
        res[name.strip()] = g
    return res


def select_models(idx, quota, rnd):
    prefab_refs = collections.defaultdict(list)
    for g, e in idx.items():
        if e["text"] and e["path"].endswith(".prefab"):
            for ref in set(re.findall(r"guid: (\w{32})", e["text"])):
                prefab_refs[ref].append(g)
    cands = []
    for g, e in idx.items():
        p = e["path"]
        if not p.lower().endswith(MODEL_EXT) or SKIP_PATH.search(p) or e["size"] > 15_000_000 or e["size"] < 2000:
            continue
        cands.append(g)
    # 프리팹이 있는 FBX = 실제 사용 에셋일 확률이 높다 → 우선
    with_prefab = [g for g in cands if prefab_refs.get(g)]
    pool = with_prefab if len(with_prefab) >= quota else cands
    # 폴더 + 이름 앞부분으로 묶어 라운드로빈 → 한 종류에 몰리지 않게
    groups = collections.defaultdict(list)
    for g in pool:
        p = idx[g]["path"]
        stem = os.path.splitext(os.path.basename(p))[0]
        key = (os.path.dirname(p), "_".join(re.split(r"[_\s-]+", stem)[:2]))
        groups[key].append(g)
    keys = list(groups)
    rnd.shuffle(keys)
    for k in keys:
        rnd.shuffle(groups[k])
    picked = []
    while len(picked) < quota and any(groups.values()):
        for k in keys:
            if groups[k] and len(picked) < quota:
                picked.append(groups[k].pop())
    return picked, prefab_refs


def resolve_materials(g, idx, prefab_refs, mat_cache):
    def mat_info(mg):
        if mg not in mat_cache:
            e = idx.get(mg)
            if not e or not e["text"]:
                mat_cache[mg] = None
            else:
                tex, color = parse_mat(e["text"])
                mat_cache[mg] = {"name": os.path.splitext(os.path.basename(e["path"]))[0],
                                 "tex": pick_main_tex(tex, idx), "color": color}
        return mat_cache[mg]

    by_name = {}
    for name, mg in external_materials(idx[g]["meta"]).items():
        mi = mat_info(mg)
        if mi:
            by_name[name] = mi
    ordered = []
    for pg in prefab_refs.get(g, [])[:1]:
        txt = idx[pg]["text"]
        for mg in re.findall(r"\{fileID: 2100000, guid: (\w+)", txt):
            mi = mat_info(mg)
            if mi and mi not in ordered:
                ordered.append(mi)
    if not any(mi["tex"] for mi in list(by_name.values()) + ordered):
        tg = nearby_texture(g, idx)
        if tg:
            ordered = [{"name": "nearby", "tex": tg, "color": None}]
    return by_name, ordered


def nearby_texture(g, idx):
    """머티리얼 연결이 없을 때: FBX 폴더 아래(없으면 상위 폴더)에서 base color 류 텍스처를 고른다."""
    d = os.path.dirname(idx[g]["path"])
    stem_tokens = set(re.split(r"[_\W\d]+", os.path.basename(idx[g]["path"]).lower())) - {"", "fbx", "low", "sm"}
    for root in (d, os.path.dirname(d)):
        cands = [h for h, e in idx.items()
                 if e["path"].lower().endswith(TEX_EXT) and e["path"].startswith(root + "/")
                 and TEX_NAME_OK.search(os.path.basename(e["path"])) and not TEX_NAME_BAD.search(os.path.basename(e["path"]))]
        if cands:
            def score(h):
                toks = set(re.split(r"[_\W\d]+", idx[h]["path"].lower()))
                return (len(stem_tokens & toks), -idx[h]["path"].count("/"))
            return max(cands, key=score)
    return None


def save_texture(raw, src_path, dst_dir):
    name = os.path.splitext(os.path.basename(src_path))[0]
    h = hashlib.md5(src_path.encode()).hexdigest()[:6]
    fn = f"{re.sub(r'[^A-Za-z0-9_-]+', '_', name)}_{h}.png"
    dst = os.path.join(dst_dir, fn)
    if not os.path.exists(dst):
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
        im.thumbnail((TEX_MAX, TEX_MAX))
        im.save(dst, optimize=True)
    return fn


def extract_members(path, wanted):
    """wanted guid 들의 asset 바이트만 꺼낸다."""
    got = {}
    with tarfile.open(path, "r:gz") as t:
        for m in t:
            g, _, kind = m.name.lstrip("./").partition("/")
            if kind == "asset" and g in wanted:
                got[g] = t.extractfile(m).read()
    return got


def main():
    # --only <slug> : 그 팩만 다시 뽑아서 기존 catalog 의 해당 항목만 교체
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    rnd = random.Random(SEED)
    pkgs = find_packages()
    catalog = []
    if only:
        catalog = [e for e in json.load(open(CATALOG, encoding="utf-8")) if e["pack"] != only]
    for fname, quota in PACKS:
        if only and slug(fname) != only:
            continue
        src = pkgs.get(fname)
        if not src:
            print("!! 패키지 없음:", fname)
            continue
        pack = slug(fname)
        print(f"[{pack}] indexing…", flush=True)
        idx = index_package(src)
        models, prefab_refs = select_models(idx, quota, rnd)
        mat_cache = {}
        plans = []
        tex_guids = set()
        for g in models:
            by_name, ordered = resolve_materials(g, idx, prefab_refs, mat_cache)
            for mi in list(by_name.values()) + ordered:
                if mi["tex"]:
                    tex_guids.add(mi["tex"])
            plans.append((g, by_name, ordered))
        raw = extract_members(src, set(models) | tex_guids)

        pdir = os.path.join(LIB, pack)
        tdir = os.path.join(pdir, "tex")
        os.makedirs(tdir, exist_ok=True)
        tex_files = {}
        for tg in tex_guids:
            if tg in raw and idx[tg]["path"].lower().endswith(TEX_EXT):
                try:
                    tex_files[tg] = save_texture(raw[tg], idx[tg]["path"], tdir)
                except Exception as ex:
                    print("   texture fail", idx[tg]["path"], ex)

        def slot(mi):
            return {"mat": mi["name"], "color": mi["color"],
                    "tex": f"library/{pack}/tex/{tex_files[mi['tex']]}" if mi["tex"] in tex_files else None}

        used = set()
        for g, by_name, ordered in plans:
            if g not in raw:
                continue
            base = os.path.basename(idx[g]["path"])
            fn = base if base not in used else f"{os.path.splitext(base)[0]}_{g[:6]}.fbx"
            used.add(fn)
            with open(os.path.join(pdir, fn), "wb") as f:
                f.write(raw[g])
            catalog.append({
                "id": f"{pack}/{os.path.splitext(fn)[0]}",
                "name": os.path.splitext(base)[0],
                "pack": pack,
                "category": os.path.basename(os.path.dirname(src)),
                "file": f"library/{pack}/{fn}",
                "sourcePackage": src,
                "sourcePath": idx[g]["path"],
                "sizeKB": round(len(raw[g]) / 1024),
                "materials": {"byName": {k: slot(v) for k, v in by_name.items()},
                              "ordered": [slot(v) for v in ordered]},
            })
        print(f"   -> {len(plans)} models, {len(tex_files)} textures", flush=True)

    os.makedirs(os.path.dirname(CATALOG), exist_ok=True)
    with open(CATALOG, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
    print("total", len(catalog), "->", CATALOG)


if __name__ == "__main__":
    sys.exit(main())
