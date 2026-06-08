export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'No username provided' });

  const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`
    });
    const { access_token } = await tokenRes.json();

    const headers = {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${access_token}`
    };

    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, { headers });
    const userData = await userRes.json();
    if (!userData.data?.length) return res.status(404).json({ error: 'Streamer not found' });
    const user = userData.data[0];

    const [followRes, streamRes] = await Promise.all([
      fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}&first=1`, { headers }),
      fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(username)}`, { headers })
    ]);
    const [followData, streamData] = await Promise.all([followRes.json(), streamRes.json()]);
    const followers = followData.total?.toLocaleString() ?? '—';
    const avgViewers = streamData.data?.[0]?.viewer_count?.toLocaleString() ?? '—';

    // Fetch up to 200 videos to cover 6 months
    let allVideos = [];
    let cursor = null;
    for (let i = 0; i < 2; i++) {
      const url = `https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=100${cursor ? '&after=' + cursor : ''}`;
      const vRes = await fetch(url, { headers });
      const vData = await vRes.json();
      allVideos = allVideos.concat(vData.data || []);
      cursor = vData.pagination?.cursor;
      if (!cursor) break;
    }

    function parseSecs(dur) {
      const m = dur?.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/) || [];
      return (parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+(parseInt(m[3]||0));
    }

    function calcPeriod(days) {
      const cutoff = Date.now() - days * 864e5;
      const vids = allVideos.filter(v => new Date(v.created_at).getTime() >= cutoff);
      if (!vids.length) return { broadcastTime: '0h 0m', activeDays: '0.0 / wk', hoursPerWeek: '0.0 / wk', hoursWatched: '—' };
      const secs = vids.reduce((a, v) => a + parseSecs(v.duration), 0);
      const daySet = new Set(vids.map(v => v.created_at.slice(0,10)));
      const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
      const weeks = days / 7;
      const hoursPerWeek = (secs / 3600 / weeks).toFixed(1);
      const activeDaysPerWeek = (daySet.size / weeks).toFixed(1);
      return {
        broadcastTime: `${h}h ${m}m`,
        activeDays: `${activeDaysPerWeek} / wk`,
        hoursPerWeek: `${hoursPerWeek} / wk`,
        hoursWatched: '—'
      };
    }

    const periods = [
      { days: '30', label: '30-DAY', ...calcPeriod(30) },
      { days: '90', label: '90-DAY', ...calcPeriod(90) },
      { days: '180', label: '6-MONTH', ...calcPeriod(180) }
    ];

    // Get game names for all videos
    const gameIds = [...new Set(allVideos.map(v => v.game_id).filter(Boolean))].slice(0, 100);
    let nameMap = {};
    if (gameIds.length) {
      const gRes = await fetch(`https://api.twitch.tv/helix/games?${gameIds.map(id=>`id=${id}`).join('&')}`, { headers });
      const gData = await gRes.json();
      nameMap = Object.fromEntries((gData.data||[]).map(g => [g.id, g.name]));
    }

    // Build last 10 games with 30 and 90 day hours
    const cutoff30 = Date.now() - 30 * 864e5;
    const cutoff90 = Date.now() - 90 * 864e5;
    const gameMap = {};

    for (const v of allVideos) {
      const name = nameMap[v.game_id] || v.game_id;
      if (!name) continue;
      const secs = parseSecs(v.duration);
      const ts = new Date(v.created_at).getTime();
      if (!gameMap[name]) gameMap[name] = { name, totalSecs: 0, secs30: 0, secs90: 0, lastPlayed: v.created_at };
      gameMap[name].totalSecs += secs;
      if (ts >= cutoff30) gameMap[name].secs30 += secs;
      if (ts >= cutoff90) gameMap[name].secs90 += secs;
    }

    function fmtHours(secs) {
      if (!secs) return '—';
      const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    // Sort by most recently played and take top 10
    const recentGames = Object.values(gameMap)
      .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
      .slice(0, 10)
      .map(g => ({
        name: g.name,
        date: new Date(g.lastPlayed).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        hours30: fmtHours(g.secs30),
        hours90: fmtHours(g.secs90)
      }));
res.json({
      displayName: user.display_name,
      followers,
      avgViewers,
      peakViewers: '—',
      periods,
      recentGames,
      debug: {
        totalVideos: allVideos.length,
        sampleVideo: allVideos[0] || null,
        gameIdsFound: gameIds.length,
        nameMapSize: Object.keys(nameMap).length
      },
      url: `https://twitchtracker.com/${username}`
    });
  
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
