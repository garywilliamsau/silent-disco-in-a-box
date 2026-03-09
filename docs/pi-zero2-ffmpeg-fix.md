# Pi Zero 2 W: FFmpeg ABI Fix

If Liquidsoap segfaults immediately on startup, it's because Raspberry Pi OS ships a patched FFmpeg with a different ABI than the one Liquidsoap was built against.

## Fix for Bookworm

Pin standard Debian FFmpeg packages over the RPi OS ones:

```bash
sudo tee /etc/apt/preferences.d/ffmpeg.pref << 'EOF'
Package: ffmpeg libavcodec-dev libavcodec59 libavdevice59 libavfilter8 libavformat-dev libavformat59 libavutil-dev libavutil57 libpostproc56 libswresample-dev libswresample4 libswscale-dev libswscale6
Pin: origin deb.debian.org
Pin-Priority: 600
EOF

sudo apt-get update
sudo apt-get dist-upgrade -y
```

## Fix for Trixie

```bash
sudo tee /etc/apt/preferences.d/ffmpeg.pref << 'EOF'
Package: ffmpeg libavcodec-dev libavcodec61 libavdevice61 libavfilter10 libavformat-dev libavformat61 libavutil-dev libavutil59 libpostproc58 libswresample-dev libswresample5 libswscale-dev libswscale8
Pin: origin deb.debian.org
Pin-Priority: 1001
EOF

sudo apt-get update
sudo apt-get install --reinstall ffmpeg
```

## Alternative: deb-multimedia repo

```bash
echo "deb https://www.deb-multimedia.org bookworm main" | sudo tee /etc/apt/sources.list.d/deb-multimedia.list
sudo apt-get update -oAcquire::AllowInsecureRepositories=true
sudo apt-get install deb-multimedia-keyring
sudo apt-get update
sudo apt-get dist-upgrade -y
```

After fixing, restart Liquidsoap:
```bash
sudo systemctl restart liquidsoap-disco
```
