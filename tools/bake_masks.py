"""
Polytope(Amplify) 마스크 셰이더처럼 '마스크 영역마다 머티리얼 색을 곱하는' 셰이더를
해석해서 색이 입혀진 albedo 텍스처를 구워 catalog 에 연결한다.
three.js 는 이런 커스텀 셰이더를 모르기 때문에 그냥 렌더링하면 하얗게 나온다.

usage: python tools/bake_masks.py
"""
import io, json, os, re, tarfile
import numpy as np
from PIL import Image

from extract import CATALOG, LIB, find_packages, slug

TARGET_PACKS = [
    "Lowpoly Medieval Modular Armors Expansion Pack 01.unitypackage",
    "Lowpoly Medieval Peasants - Free pack.unitypackage",
]


def read_package(path):
    ents = {}
    with tarfile.open(path, "r:gz") as t:
        for m in t:
            g, _, k = m.name.lstrip("./").partition("/")
            if m.isfile() and k in ("pathname", "asset") and m.size < 20_000_000:
                ents.setdefault(g, {})[k] = t.extractfile(m).read()
    out = {}
    for g, e in ents.items():
        if "pathname" in e:
            out[g] = {"path": e["pathname"].decode("utf-8", "ignore").splitlines()[0], "data": e.get("asset")}
    return out


def parse_shader(src):
    """albedo 합성 단계를 [(베이스 텍스처 prop, 색 prop, 가중치 정의)] 로 뽑는다."""
    nodes = dict(re.findall(r"float4 (tex2DNode\d+) = tex2D\( (_\w+),", src))
    consts = {k: tuple(map(float, v.split(","))) for k, v in
              re.findall(r"float4 (color\d+) = IsGammaSpace\(\) \? float4\(([^)]*)\)", src)}
    casts = {k: (n, ch) for k, n, ch in re.findall(r"float3 (temp_cast_\d+) = \((tex2DNode\d+)\.([rgba])\)\.xxx", src)}

    def operand(tok):
        tok = tok.strip()
        m = re.fullmatch(r"(color\d+)\.rgb", tok)
        if m:
            return ("const", consts[m.group(1)][:3])
        m = re.fullmatch(r"(tex2DNode\d+)\.rgb", tok)
        if m:
            return ("tex", nodes[m.group(1)], None)
        if tok in casts:
            n, ch = casts[tok]
            return ("tex", nodes[n], ch)
        if re.fullmatch(r"float3\( *0, *0, *0 *\)", tok):
            return ("const", (0.0, 0.0, 0.0))
        raise ValueError(tok)

    def weight(expr):
        m = re.search(r"distance\( (.+?) , (.+?) \) - ([\d.]+)", expr)
        a, b = operand(m.group(1)), operand(m.group(2))
        tex, const = (a, b) if a[0] == "tex" else (b, a)
        return {"tex": tex[1], "ch": tex[2], "key": const[1], "thr": float(m.group(3))}

    temps = {}
    for name, expr in re.findall(r"float (temp_output_\w+) = (saturate\( \( 1\.0 - \( \( distance.+);", src):
        temps[name] = weight(expr)
    steps = []
    for line in src.splitlines():
        m = re.search(r"float4 lerpResult\d+ = lerp\( \w+(?:\( 0,0,0,0 \))? , \( (tex2DNode\d+) \* (_\w+) \) , (.+)\);", line)
        if not m:
            continue
        w = m.group(3).strip()
        steps.append((nodes[m.group(1)], m.group(2), temps[w] if w in temps else weight(w)))
    return steps


def parse_mat(text):
    tex = dict(re.findall(r"- (_\w+):\s*\n\s*m_Texture: \{fileID: -?\d+, guid: (\w+)", text))
    cols = {k: tuple(float(x) for x in v) for k, *v in
            re.findall(r"- (_\w+): \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+)", text)}
    shader = re.search(r"m_Shader: \{fileID: \d+, guid: (\w+)", text)
    return tex, cols, shader.group(1) if shader else None


def load_img(data, size=None):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.NEAREST)
    return np.asarray(im, dtype=np.float32) / 255.0


def bake(steps, mat_tex, mat_cols, pkg):
    base_prop = steps[0][0]
    base = load_img(pkg[mat_tex[base_prop]]["data"])
    size = (base.shape[1], base.shape[0])
    cache = {}
    out = np.zeros_like(base)
    for tex_prop, col_prop, w in steps:
        g = mat_tex.get(w["tex"])
        if not g or g not in pkg or col_prop not in mat_cols:
            continue
        if g not in cache:
            cache[g] = load_img(pkg[g]["data"], size)
        mask = cache[g]
        if w["ch"]:
            v = mask[..., "rgba".index(w["ch"])][..., None]
            d = np.abs(v - w["key"][0])[..., 0]
        else:
            d = np.linalg.norm(mask - np.array(w["key"], dtype=np.float32), axis=-1)
        sel = d <= w["thr"]
        out[sel] = base[sel] * np.clip(np.array(mat_cols[col_prop], dtype=np.float32), 0, 1)
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def main():
    pkgs = find_packages()
    catalog = json.load(open(CATALOG, encoding="utf-8"))
    for fname in TARGET_PACKS:
        pack = slug(fname)
        pkg = read_package(pkgs[fname])
        shaders = {g: parse_shader(e["data"].decode("utf-8", "ignore"))
                   for g, e in pkg.items() if e["path"].endswith(".shader") and e["data"]}
        baked = {}
        for g, e in pkg.items():
            if not e["path"].endswith(".mat") or not e["data"]:
                continue
            tex, cols, sh = parse_mat(e["data"].decode("utf-8", "ignore"))
            if sh not in shaders or not shaders[sh]:
                continue
            name = os.path.splitext(os.path.basename(e["path"]))[0]
            img = bake(shaders[sh], tex, cols, pkg)
            fn = f"baked_{re.sub(r'[^A-Za-z0-9_-]+', '_', name)}.png"
            img.save(os.path.join(LIB, pack, "tex", fn), optimize=True)
            baked[name] = f"library/{pack}/tex/{fn}"
            print(f"[{pack}] baked {name} ({len(shaders[sh])} regions)")
        n = 0
        for entry in catalog:
            if entry["pack"] != pack:
                continue
            slots = list(entry["materials"]["byName"].values()) + entry["materials"]["ordered"]
            for s in slots:
                if s["mat"] in baked:
                    s["tex"] = baked[s["mat"]]
                    n += 1
            entry.pop("thumb", None)  # 다시 렌더링하도록
        print(f"   {n} slots updated")
    json.dump(catalog, open(CATALOG, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
