import {createWorkDialog} from './warehouse-work-ui.mjs';

export function scanFieldCode(title='扫描货品或格位码') {
  const panel=createWorkDialog(title),{root,body,message}=panel;
  const video=document.createElement('video');video.autoplay=true;video.muted=true;video.playsInline=true;video.style.cssText='width:100%;max-height:40dvh;background:#08111f';
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  const camera=document.createElement('button');camera.textContent='打开摄像头';
  const photo=document.createElement('input');photo.type='file';photo.accept='image/*';photo.setAttribute('capture','environment');photo.setAttribute('aria-label','选择条码照片');
  const hint=document.createElement('p');hint.className='work-hint';hint.textContent='对准一个格位码或货品条码。摄像头需要可信 HTTPS；也可选择二维码照片。';body.append(hint,camera,photo,video);
  let stream,frame,closed=false,finished='',detector;
  try{if(globalThis.BarcodeDetector)detector=new BarcodeDetector();}catch{}
  if(!detector)hint.textContent+=' 当前浏览器的图片识别支持二维码；其它条码可使用扫描枪或手动输入。';
  async function detect(source,width,height){
    const scale=Math.min(1,960/width);canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);context.drawImage(source,0,0,canvas.width,canvas.height);
    if(detector){const values=await detector.detect(canvas);if(values[0]?.rawValue)return values[0].rawValue;}
    if(window.jsQR){const data=context.getImageData(0,0,canvas.width,canvas.height);return window.jsQR(data.data,data.width,data.height)?.data||'';}return '';
  }
  const accept=value=>{if(value&&!closed){finished=value;root.close();}};
  async function tick(){if(closed)return;try{if(video.videoWidth)accept(await detect(video,video.videoWidth,video.videoHeight));}catch{message.textContent='暂未识别，请靠近标签或调整光线。';}if(!closed)frame=setTimeout(tick,180);}
  camera.onclick=async()=>{
    if(!navigator.mediaDevices?.getUserMedia){message.textContent='此地址无法调用摄像头，请使用可信 HTTPS，或选择二维码照片、手动输入。';return;}
    camera.disabled=true;
    try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});if(closed){stream.getTracks().forEach(track=>track.stop());return;}video.srcObject=stream;await video.play();tick();}
    catch{message.textContent='摄像头未打开，可选择二维码照片或返回手动输入。';camera.disabled=false;}
  };
  photo.onchange=async()=>{
    const file=photo.files[0];photo.value='';if(!file)return;
    if(file.size>8*1024*1024){message.textContent='请选择8MB以内的条码照片。';return;}
    let bitmap;
    try{bitmap=await createImageBitmap(file);const code=await detect(bitmap,bitmap.width,bitmap.height);if(code)accept(code);else message.textContent='未识别到支持的条码，请只拍摄一个二维码或返回手动输入。';}
    catch{message.textContent='照片无法识别，请重新选择或返回手动输入。';}finally{bitmap?.close();}
  };
  return new Promise(resolve=>root.addEventListener('close',()=>{closed=true;clearTimeout(frame);stream?.getTracks().forEach(track=>track.stop());resolve(finished);},{once:true}));
}
