// 一次导航包括库区列表和场景读取；只有最后一次请求可以提交视图。
export function createSceneNavigation({readScene, readRooms, current, commit}) {
  let revision = 0;
  async function navigate({roomCode, siteCode, firstRoom = false}) {
    const request = ++revision;
    const before = current();
    let rooms;
    try {
      siteCode = siteCode || (roomCode ? roomCode.split('-')[0] : before.siteCode);
      if (firstRoom || siteCode !== before.siteCode) {
        rooms = await readRooms(siteCode);
        if (request !== revision) return false;
        if (firstRoom) {
          if (!rooms.length) throw Error('该仓库没有库区，请先创建库区');
          roomCode = rooms[0].loc_code;
        }
      }
      const spec = await readScene(roomCode ?? before.roomCode);
      if (request !== revision) return false;
      if (!spec || !Array.isArray(spec.furniture)) throw Error('场景数据格式无效');
      commit({spec, siteCode, rooms});
      return true;
    } catch (error) {
      if (request !== revision) return false;
      throw error;
    }
  }
  return {
    cancelPending: () => { revision++; },
    loadRoom: roomCode => navigate({roomCode}),
    loadSite: siteCode => navigate({siteCode, firstRoom:true}),
  };
}
