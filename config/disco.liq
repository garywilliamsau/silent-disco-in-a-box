#!/usr/bin/liquidsoap

# Silent Disco in a Box - Liquidsoap 2.x Configuration
# 3 channels with playlist sources
# ALSA line-in can be enabled later when USB audio adapters are connected

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

# === BLUETOOTH AUDIO INPUT ===
# Captures from PulseAudio A2DP sink via bt-capture.sh
# Fallible source: unavailable when no BT device is streaming
bt_input = input.external(
  id="bt_input",
  buffer=2.0,
  channels=2,
  samplerate=44100,
  restart_on_error=true,
  max=10.0,
  "/opt/disco/config/bt-capture.sh"
)

# === SPOTIFY CONNECT INPUTS ===
# Each channel has its own raspotify instance outputting to a loopback subdevice
# Red=subdevice 1, Green=subdevice 2, Blue=subdevice 3
spotify_red = input.external(
  id="spotify_red",
  buffer=2.0,
  channels=2,
  samplerate=44100,
  restart_on_error=true,
  max=10.0,
  "/opt/disco/config/spotify-capture.sh 1"
)

spotify_green = input.external(
  id="spotify_green",
  buffer=2.0,
  channels=2,
  samplerate=44100,
  restart_on_error=true,
  max=10.0,
  "/opt/disco/config/spotify-capture.sh 2"
)

spotify_blue = input.external(
  id="spotify_blue",
  buffer=2.0,
  channels=2,
  samplerate=44100,
  restart_on_error=true,
  max=10.0,
  "/opt/disco/config/spotify-capture.sh 3"
)

# Per-channel Spotify toggle
red_use_spotify = ref(false)
green_use_spotify = ref(false)
blue_use_spotify = ref(false)

# === TALKOVER (voice broadcast over all channels) ===
# Reads raw S16LE mono 44100Hz PCM from a named pipe fed by the Node.js server
talkover_input = input.external(
  id="talkover",
  buffer=0.5,
  channels=1,
  samplerate=44100,
  restart_on_error=true,
  max=5.0,
  "/opt/disco/config/talkover-capture.sh"
)
talkover_stereo = audio_to_stereo(talkover_input)
talkover_safe = mksafe(talkover_stereo)

# Ducking: when talkover is active, music drops to 30% volume
talkover_active = ref(false)

server.register(
  namespace="talkover",
  description="Set talkover active state for ducking",
  usage="set_active true|false",
  "set_active",
  fun(v) -> begin
    talkover_active := (v == "true")
    "OK"
  end
)

def duck_volume()
  if talkover_active() then 0.3 else 1.0 end
end

# Per-channel Bluetooth toggle (mutually exclusive, managed by API)
red_use_bt = ref(false)
green_use_bt = ref(false)
blue_use_bt = ref(false)

# === CHANNEL: RED ===

red_playlist = playlist(
  id="red_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/red"
)

red_queue = request.queue(id="red_queue")
red_bt = switch(track_sensitive=false, [(fun() -> red_use_bt(), bt_input)])
red_spotify = switch(track_sensitive=false, [(fun() -> red_use_spotify(), spotify_red)])
red_source = fallback(track_sensitive=false, [red_bt, red_spotify, red_queue, red_playlist])
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

server.register(
  namespace="red",
  description="Enable/disable Bluetooth on red channel",
  usage="set_bt true|false",
  "set_bt",
  fun(v) -> begin
    red_use_bt := (v == "true")
    if v == "true" then
      green_use_bt := false
      blue_use_bt := false
    end
    "OK"
  end
)

server.register(
  namespace="red",
  description="Get Bluetooth status for red channel",
  usage="get_bt",
  "get_bt",
  fun(_) -> if red_use_bt() then "true" else "false" end
)

server.register(
  namespace="red",
  description="Enable/disable Spotify on red channel",
  usage="set_spotify true|false",
  "set_spotify",
  fun(v) -> begin
    red_use_spotify := (v == "true")
    "OK"
  end
)

server.register(
  namespace="red",
  description="Get Spotify status for red channel",
  usage="get_spotify",
  "get_spotify",
  fun(_) -> if red_use_spotify() then "true" else "false" end
)

red_output = add(normalize=false, [amplify(duck_volume, red_safe), amplify(1.5, talkover_safe)])

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
  red_output
)

# === CHANNEL: GREEN ===

green_playlist = playlist(
  id="green_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/green"
)

green_queue = request.queue(id="green_queue")
green_bt = switch(track_sensitive=false, [(fun() -> green_use_bt(), bt_input)])
green_spotify = switch(track_sensitive=false, [(fun() -> green_use_spotify(), spotify_green)])
green_source = fallback(track_sensitive=false, [green_bt, green_spotify, green_queue, green_playlist])
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

server.register(
  namespace="green",
  description="Enable/disable Bluetooth on green channel",
  usage="set_bt true|false",
  "set_bt",
  fun(v) -> begin
    green_use_bt := (v == "true")
    if v == "true" then
      red_use_bt := false
      blue_use_bt := false
    end
    "OK"
  end
)

server.register(
  namespace="green",
  description="Get Bluetooth status for green channel",
  usage="get_bt",
  "get_bt",
  fun(_) -> if green_use_bt() then "true" else "false" end
)

server.register(
  namespace="green",
  description="Enable/disable Spotify on green channel",
  usage="set_spotify true|false",
  "set_spotify",
  fun(v) -> begin
    green_use_spotify := (v == "true")
    "OK"
  end
)

server.register(
  namespace="green",
  description="Get Spotify status for green channel",
  usage="get_spotify",
  "get_spotify",
  fun(_) -> if green_use_spotify() then "true" else "false" end
)

green_output = add(normalize=false, [amplify(duck_volume, green_safe), amplify(1.5, talkover_safe)])

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
  green_output
)

# === CHANNEL: BLUE ===

blue_playlist = playlist(
  id="blue_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/blue"
)

blue_queue = request.queue(id="blue_queue")
blue_bt = switch(track_sensitive=false, [(fun() -> blue_use_bt(), bt_input)])
blue_spotify = switch(track_sensitive=false, [(fun() -> blue_use_spotify(), spotify_blue)])
blue_source = fallback(track_sensitive=false, [blue_bt, blue_spotify, blue_queue, blue_playlist])
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

server.register(
  namespace="blue",
  description="Enable/disable Bluetooth on blue channel",
  usage="set_bt true|false",
  "set_bt",
  fun(v) -> begin
    blue_use_bt := (v == "true")
    if v == "true" then
      red_use_bt := false
      green_use_bt := false
    end
    "OK"
  end
)

server.register(
  namespace="blue",
  description="Get Bluetooth status for blue channel",
  usage="get_bt",
  "get_bt",
  fun(_) -> if blue_use_bt() then "true" else "false" end
)

server.register(
  namespace="blue",
  description="Enable/disable Spotify on blue channel",
  usage="set_spotify true|false",
  "set_spotify",
  fun(v) -> begin
    blue_use_spotify := (v == "true")
    "OK"
  end
)

server.register(
  namespace="blue",
  description="Get Spotify status for blue channel",
  usage="get_spotify",
  "get_spotify",
  fun(_) -> if blue_use_spotify() then "true" else "false" end
)

blue_output = add(normalize=false, [amplify(duck_volume, blue_safe), amplify(1.5, talkover_safe)])

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
  blue_output
)
