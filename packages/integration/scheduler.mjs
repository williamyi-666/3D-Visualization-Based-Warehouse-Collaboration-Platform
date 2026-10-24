// 每轮完成后再计时，网络慢或失败时不会堆积并发派发。
export function startDispatchLoop({dispatch,intervalMs=0,report=()=>{},onError=()=>{},schedule=setTimeout,cancel=clearTimeout}) {
  let stopped=false,timer;
  async function run() {
    if(stopped)return;
    try {report(await dispatch());} catch(error) {onError(error);}
    finally {
      if(!stopped && intervalMs>0) {
        timer=schedule(run,intervalMs);
        timer?.unref?.();
      }
    }
  }
  void run();
  return ()=>{stopped=true;if(timer!==undefined)cancel(timer);};
}
