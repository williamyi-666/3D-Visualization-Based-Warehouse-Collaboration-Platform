import {createWorkDialog} from './warehouse-work-ui.mjs';

export function createMobileAccessUI({getRoom,getLoc}){
  return function open(){
    const panel=createWorkDialog('手机访问'),body=panel.body;
    panel.root.classList.add('mobile-access-dialog');
    const context={room:getRoom(),loc:getLoc()},initial=new URL('./index.html',location.href);
    const hint=document.createElement('p');hint.className='work-hint';hint.textContent='手机扫码打开平台，自动进入作业界面。请连接能够访问此平台的网络。';body.append(hint);
    const code=document.createElement('div');code.className='mobile-access-code';code.setAttribute('aria-label','手机访问二维码');body.append(code);
    const id='mobile-access-address',label=document.createElement('label'),address=document.createElement('input');
    label.htmlFor=id;label.textContent='手机访问地址';address.id=id;address.type='url';address.value=initial.href;body.append(label,address);
    const status=document.createElement('p');status.className='work-message';status.setAttribute('role','status');body.append(status);
    const actions=document.createElement('div');actions.className='work-actions';const copy=document.createElement('button');copy.type='button';copy.className='primary';copy.textContent='复制地址';actions.append(copy);body.append(actions);
    const account=document.createElement('p');account.className='work-hint';account.textContent='手机与电脑使用同一套仓库账号，首次访问需登录。';body.append(account);
    const switcher=document.createElement('a');switcher.href=window.SpatialInterface.url('mobile',context);switcher.textContent='在本机切换手机作业版';body.append(switcher);
    function render(){
      code.replaceChildren();copy.disabled=true;status.textContent='';
      try{
        const target=new URL(address.value);
        if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('请填写完整的 http 或 https 平台地址。');
        if(['localhost','0.0.0.0','[::1]'].includes(target.hostname)||/^127\./.test(target.hostname))throw Error('当前地址仅能在本机访问，请改为部署电脑的局域网地址。');
        if(target.pathname==='/')target.pathname=initial.pathname;
        target.search='';target.hash='';
        for(const [name,value] of Object.entries(context))if(value)target.searchParams.set(name,value);
        const qr=window.qrcode(0,'M');qr.addData(target.href);qr.make();code.innerHTML=qr.createImgTag(5,16,'手机访问二维码');
        copy.disabled=false;return target.href;
      }catch(error){status.textContent=error.message;return '';}
    }
    address.oninput=render;address.onchange=()=>{const value=render();if(value)address.value=value;};
    copy.onclick=async()=>{
      const value=render();if(!value)return;address.value=value;
      try{await navigator.clipboard.writeText(value);status.textContent='地址已复制。';}
      catch{address.focus();address.select();status.textContent=document.execCommand('copy')?'地址已复制。':'请复制上方已选中的地址。';}
    };
    const value=render();if(value)address.value=value;
  };
}
