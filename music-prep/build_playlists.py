#!/usr/bin/env python3
"""Dedup downloaded tracks against the existing Pi library, then emit
playlist JSONs + an upload list + a human report."""
import json, os, re, sys, unicodedata, subprocess
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(BASE, "downloads")
OUT = os.path.join(BASE, "out")
os.makedirs(OUT, exist_ok=True)

PLAYLISTS = [
    ("christmas", "Christmas in July", "christmas-in-july"),
    ("hot",       "Dancefloor Hits",   "dancefloor-hits"),
    ("retro",     "Retro Dance Bangers","retro-dance-bangers"),
]

def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))

def norm(s):
    s = strip_accents(s).lower().replace("&", " and ")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)          # drop (...) [...]
    s = re.sub(r"\s-\s.*$", " ", s)                  # drop " - Radio Edit" style suffix
    s = re.sub(r"\b(feat|ft|featuring|with)\b.*$", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def split_line(line):
    # "Artist - Title"  (split on first ' - ')
    parts = line.split(" - ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return "", line

NOISE = {"feat","ft","featuring","with","remaster","remastered","edit","radio",
         "mix","version","original","instrumental","live","the","a","an","of",
         "pt","part","single","remix","extended","club","vocal","video","mono",
         "stereo","mixes","deluxe","remixes","explicit"}

def toks(s):
    s = strip_accents(s).lower().replace("p!nk", "pink").replace("ke$ha", "kesha").replace("$", "s")
    s = s.replace("&", " and ").replace("+", " ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return {w for w in s.split() if w and w not in NOISE and len(w) > 1}

def artist_tokens(artist):
    return toks(artist)

# ---- load existing Pi catalog ----
with open(os.path.join(BASE, "pi-catalog.json")) as f:
    pi = json.load(f)
pi_index = []
for t in pi:
    fn = t.get("filename", "")
    art = t.get("artist", "") or ""
    tit = t.get("title", "") or ""
    pi_index.append({"filename": fn, "atoks": toks(art), "toks": toks(art) | toks(tit),
                     "raw_art": art, "raw_tit": tit})

# ---- index downloaded files per playlist ----
def index_downloads(folder):
    out = []
    d = os.path.join(DL, folder)
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.lower().endswith(".mp3"):
            continue
        base = fn[:-4]
        art, tit = split_line(base)
        out.append({"filename": fn, "path": os.path.join(d, fn),
                    "atoks": toks(art), "toks": toks(art) | toks(tit), "raw": base})
    return out

def match(d_atoks, d_toks, candidates):
    # token overlap-coefficient; accept on (artist-share & >=0.7) or strong (>=0.85)
    best, best_score = None, 0.0
    for c in candidates:
        inter = d_toks & c["toks"]
        if not inter:
            continue
        overlap = len(inter) / min(len(d_toks), len(c["toks"]))
        art_share = bool(d_atoks & c["toks"])
        ok = (art_share and overlap >= 0.70) or (overlap >= 0.85)
        if ok and overlap > best_score:
            best, best_score = c, overlap
    return best

def ffdur(path):
    try:
        r = subprocess.run(["ffprobe","-v","quiet","-show_entries","format=duration",
                            "-of","default=noprint_wrappers=1:nokey=1", path],
                           capture_output=True, text=True, timeout=15)
        return float(r.stdout.strip())
    except Exception:
        return None

report = []
upload_files = {}   # path -> filename, deduped
for key, name, pid in PLAYLISTS:
    desired = []
    with open(os.path.join(BASE, f"{key}.txt")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                desired.append(line)
    dls = index_downloads(key)
    used_dl = set()
    tracks = []
    reuse, new, missing, longflag = [], [], [], []
    for line in desired:
        art_raw, tit_raw = split_line(line)
        d_atoks = artist_tokens(art_raw)
        d_toks = toks(art_raw) | toks(tit_raw)
        e = match(d_atoks, d_toks, pi_index)
        if e:
            tracks.append(e["filename"]); reuse.append((line, e["filename"]))
            continue
        d = match(d_atoks, d_toks, [c for c in dls if c["filename"] not in used_dl])
        if d:
            used_dl.add(d["filename"])
            tracks.append(d["filename"]); new.append((line, d["filename"]))
            upload_files[d["path"]] = d["filename"]
            dur = ffdur(d["path"])
            if dur and dur > 360:
                longflag.append((d["filename"], int(dur//60), int(dur%60)))
        else:
            missing.append(line)
    pl = {"id": pid, "name": name, "createdAt": datetime.now().isoformat(), "tracks": tracks}
    with open(os.path.join(OUT, f"{pid}.json"), "w") as f:
        json.dump(pl, f, indent=2)
    report.append({"key": key, "name": name, "pid": pid, "total": len(tracks),
                   "reuse": reuse, "new": new, "missing": missing, "long": longflag,
                   "desired": len(desired)})

# upload list
with open(os.path.join(OUT, "upload-list.txt"), "w") as f:
    for p in sorted(upload_files):
        f.write(p + "\n")

# ---- print report ----
print("="*70)
for r in report:
    print(f"\n### {r['name']}  ({r['pid']}.json)  —  {r['total']} tracks")
    print(f"    reuse existing: {len(r['reuse'])}   new upload: {len(r['new'])}   MISSING: {len(r['missing'])}   (from {r['desired']} desired)")
    if r["missing"]:
        print("    MISSING (no download + not in library):")
        for m in r["missing"]:
            print(f"      - {m}")
    if r["long"]:
        print("    LONG (>6min, eyeball these):")
        for fn,mm,ss in r["long"]:
            print(f"      - {fn}  ({mm}:{ss:02d})")
print("\n" + "="*70)
print(f"Files to upload: {len(upload_files)}")
print(f"Playlists written to: {OUT}")
