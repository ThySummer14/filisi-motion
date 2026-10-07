#!/usr/bin/env python3
"""Generate an original public-domain test pattern + synthesized tones (requires ffmpeg).
No recordings, third-party footage, fonts or private media are used.
"""
import math, pathlib, struct, subprocess, tempfile, wave
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'examples'/'media-sync-test.mp4'
w,h,fps,seconds=320,180,12,4
with tempfile.TemporaryDirectory(prefix='filisi-media-fixture-') as tmp:
    tmp=pathlib.Path(tmp)
    wav=tmp/'tones.wav'
    with wave.open(str(wav),'wb') as audio:
        audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(48000)
        data=bytearray()
        for i in range(seconds*48000):
            t=i/48000;phase=t%1
            envelope=min(1,phase/.012,max(0,(.22-phase)/.025)) if phase<.22 else 0
            value=int(14000*envelope*math.sin(2*math.pi*(440+110*int(t))*t))
            data+=struct.pack('<h',value)
        audio.writeframes(data)
    colors=[(28,68,112),(62,99,55),(126,64,58),(76,53,114)]
    for n in range(seconds*fps):
        t=n/fps;bg=colors[min(3,int(t))];pixels=bytearray(bg*(w*h))
        boxx=15+int((w-80)*(t/seconds));boxy=67
        for y in range(h):
            for x in range(w):
                color=None
                if boxx<=x<boxx+55 and boxy<=y<boxy+48:color=(229,234,212)
                if 14<=x<14+int((w-28)*(t/seconds)) and 156<=y<162:color=(126,192,255)
                if x<10 and t%1<.22:color=(255,234,117)
                if color:pixels[(y*w+x)*3:(y*w+x)*3+3]=bytes(color)
        (tmp/f'{n:04d}.ppm').write_bytes(f'P6\n{w} {h}\n255\n'.encode()+pixels)
    subprocess.run(['ffmpeg','-v','error','-y','-threads','1','-framerate',str(fps),'-i',str(tmp/'%04d.ppm'),'-i',str(wav),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest',str(out)],check=True)
print(out)
