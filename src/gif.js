// Original GIF89a writer. Fixed RGB332 palette; short literal LZW blocks avoid
// dictionary-width ambiguity. No dependencies; intentionally trades size for simplicity.
export class GifEncoder {
 constructor(width,height,fps=12){this.width=width;this.height=height;this.fps=fps;this.frames=0;this.parts=[];
 const bytes=[];const ascii=s=>bytes.push(...Array.from(s,c=>c.charCodeAt(0)));const u16=n=>bytes.push(n&255,n>>8&255);
 ascii('GIF89a');u16(width);u16(height);bytes.push(0xf7,0,0);
 for(let i=0;i<256;i++)bytes.push(Math.round((i>>5)*255/7),Math.round((i>>2&7)*255/7),Math.round((i&3)*255/3));
 bytes.push(0x21,0xff,11);ascii('NETSCAPE2.0');bytes.push(3,1,0,0,0);this.parts.push(new Uint8Array(bytes));}
 addFrame(rgba){if(rgba.length!==this.width*this.height*4)throw Error('帧尺寸不匹配');
 const delay=Math.round((this.frames+1)*100/this.fps)-Math.round(this.frames*100/this.fps);this.frames++;
 this.parts.push(new Uint8Array([0x21,0xf9,4,0,delay&255,delay>>8,0,0,0x2c,0,0,0,0,this.width&255,this.width>>8,this.height&255,this.height>>8,0,8]));
 const pixels=this.width*this.height;const data=new Uint8Array(Math.ceil((pixels+Math.ceil(pixels/200)+2)*9/8));let pos=0,bits=0,buffer=0;
 const write=code=>{buffer|=code<<bits;bits+=9;while(bits>=8){data[pos++]=buffer&255;buffer>>>=8;bits-=8;}};
 for(let i=0;i<pixels;i++){if(i%200===0)write(256);const j=i*4;write((rgba[j]>>5)<<5|(rgba[j+1]>>5)<<2|(rgba[j+2]>>6));}write(257);if(bits)data[pos++]=buffer&255;
 for(let i=0;i<pos;i+=255){const block=data.subarray(i,Math.min(i+255,pos));this.parts.push(new Uint8Array([block.length]),block);}this.parts.push(new Uint8Array([0]));}
 finish(){this.parts.push(new Uint8Array([0x3b]));return new Blob(this.parts,{type:'image/gif'});}
}
