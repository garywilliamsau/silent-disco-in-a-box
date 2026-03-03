#!/usr/bin/liquidsoap

# Silent Disco in a Box - Liquidsoap 2.x Configuration
# 3 channels, each with playlist + dedicated USB audio line-in

# Logging
log.file.set(true)
log.file.path.set("/var/log/liquidsoap/disco.log")
log.stdout.set(false)
log.level.set(3)

# Telnet server for remote control from Node.js
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("127.0.0.1")
settings.server.telnet.port.set(1234)

# Audio settings
settings.frame.audio.samplerate.set(44100)
settings.frame.audio.channels.set(2)

# === CHANNEL: RED ===

red_playlist = playlist(
  id="red_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/red"
)

red_use_alsa = interactive.bool("red_use_alsa", false)

red_alsa = input.alsa(
  id="red_alsa",
  bufferize=true,
  fallible=true,
  device="hw:1,0"
)

red_source = switch(
  id="red_switch",
  track_sensitive=false,
  [
    ({red_use_alsa()}, red_alsa),
    ({true}, red_playlist)
  ]
)

red_safe = mksafe(red_source)

red_now_playing = ref([("artist",""), ("title",""), ("filename","")])

red_safe.on_metadata(fun(m) -> begin
  red_now_playing := m
end)

server.register(
  namespace="red",
  description="Get now-playing metadata for red channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = red_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="red",
  description="Skip current track on red channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(red_safe)
    "Skipped."
  end
)

output.icecast(
  id="red_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/red",
  name="Red Channel",
  description="Silent Disco - Red",
  public=false,
  fallible=false,
  red_safe
)

# === CHANNEL: GREEN ===

green_playlist = playlist(
  id="green_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/green"
)

green_use_alsa = interactive.bool("green_use_alsa", false)

green_alsa = input.alsa(
  id="green_alsa",
  bufferize=true,
  fallible=true,
  device="hw:2,0"
)

green_source = switch(
  id="green_switch",
  track_sensitive=false,
  [
    ({green_use_alsa()}, green_alsa),
    ({true}, green_playlist)
  ]
)

green_safe = mksafe(green_source)

green_now_playing = ref([("artist",""), ("title",""), ("filename","")])

green_safe.on_metadata(fun(m) -> begin
  green_now_playing := m
end)

server.register(
  namespace="green",
  description="Get now-playing metadata for green channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = green_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="green",
  description="Skip current track on green channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(green_safe)
    "Skipped."
  end
)

output.icecast(
  id="green_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/green",
  name="Green Channel",
  description="Silent Disco - Green",
  public=false,
  fallible=false,
  green_safe
)

# === CHANNEL: BLUE ===

blue_playlist = playlist(
  id="blue_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/blue"
)

blue_use_alsa = interactive.bool("blue_use_alsa", false)

blue_alsa = input.alsa(
  id="blue_alsa",
  bufferize=true,
  fallible=true,
  device="hw:3,0"
)

blue_source = switch(
  id="blue_switch",
  track_sensitive=false,
  [
    ({blue_use_alsa()}, blue_alsa),
    ({true}, blue_playlist)
  ]
)

blue_safe = mksafe(blue_source)

blue_now_playing = ref([("artist",""), ("title",""), ("filename","")])

blue_safe.on_metadata(fun(m) -> begin
  blue_now_playing := m
end)

server.register(
  namespace="blue",
  description="Get now-playing metadata for blue channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = blue_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="blue",
  description="Skip current track on blue channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(blue_safe)
    "Skipped."
  end
)

output.icecast(
  id="blue_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/blue",
  name="Blue Channel",
  description="Silent Disco - Blue",
  public=false,
  fallible=false,
  blue_safe
)
