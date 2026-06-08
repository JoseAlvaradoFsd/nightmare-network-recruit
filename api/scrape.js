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

    // Fetch up to 200 videos
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

    function fmtHours(secs) {
      if (!secs) return '—';
      const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const cutoff30 = Date.now() - 30 * 864e5;
    const cutoff90 = Date.now() - 90 * 864e5;

    function calcPeriod(days) {
      const cutoff = Date.now() - days * 864e5;
      const vids = allVideos.filter(v => new Date(v.created_at).getTime() >= cutoff);
      if (!vids.length) return { broadcastTime: '0h 0m', activeDays: '0.0 / wk', hoursPerWeek: '0.0 / wk', hoursWatched: '—' };
      const secs = vids.reduce((a, v) => a + parseSecs(v.duration), 0);
      const daySet = new Set(vids.map(v => v.created_at.slice(0,10)));
      const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
      const weeks = days / 7;
      return {
        broadcastTime: `${h}h ${m}m`,
        activeDays: `${(daySet.size / weeks).toFixed(1)} / wk`,
        hoursPerWeek: `${(secs / 3600 / weeks).toFixed(1)} / wk`,
        hoursWatched: '—'
      };
    }

    // Calculate total stream hours for 30 and 90 day periods
    const totalSecs30 = allVideos
      .filter(v => new Date(v.created_at).getTime() >= cutoff30)
      .reduce((a, v) => a + parseSecs(v.duration), 0);
    const totalSecs90 = allVideos
      .filter(v => new Date(v.created_at).getTime() >= cutoff90)
      .reduce((a, v) => a + parseSecs(v.duration), 0);

    const periods = [
      { days: '30', label: '30-DAY', ...calcPeriod(30) },
      { days: '90', label: '90-DAY', ...calcPeriod(90) },
      { days: '180', label: '6-MONTH', ...calcPeriod(180) }
    ];

    // Get games from clips
    let clips = [];
    let clipCursor = null;
    for (let i = 0; i < 3; i++) {
      const clipUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=100${clipCursor ? '&after=' + clipCursor : ''}`;
      const cRes = await fetch(clipUrl, { headers });
      const cData = await cRes.json();
      clips = clips.concat(cData.data || []);
      clipCursor = cData.pagination?.cursor;
      if (!clipCursor || clips.length >= 300) break;
    }

    const channelRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${user.id}`, { headers });
    const channelData = await channelRes.json();
    const currentGame = channelData.data?.[0];

    const gameMap = {};

    if (currentGame?.game_id && currentGame?.game_name) {
      gameMap[currentGame.game_name] = {
        name: currentGame.game_name,
        lastPlayed: new Date().toISOString()
      };
    }

    const clipGameIds = [...new Set(clips.map(c => c.game_id).filter(Boolean))].slice(0, 100);
    let clipNameMap = {};
    if (clipGameIds.length) {
      const gRes = await fetch(`https://api.twitch.tv/helix/games?${clipGameIds.map(id=>`id=${id}`).join('&')}`, { headers });
      const gData = await gRes.json();
      clipNameMap = Object.fromEntries((gData.data||[]).map(g => [g.id, g.name]));
    }

    for (const c of clips) {
      const name = clipNameMap[c.game_id];
      if (!name) continue;
      if (!gameMap[name]) gameMap[name] = { name, lastPlayed: c.created_at };
      if (new Date(c.created_at) > new Date(gameMap[name].lastPlayed)) {
        gameMap[name].lastPlayed = c.created_at;
      }
    }

    // Fallback to video titles if no clips
    if (Object.keys(gameMap).length === 0) {
      for (const v of allVideos.slice(0, 10)) {
        const name = v.title || 'Unknown Stream';
        if (!gameMap[name]) gameMap[name] = { name, lastPlayed: v.created_at };
      }
    }

    const recentGames = Object.values(gameMap)
      .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
      .slice(0, 10)
      .map(g => ({
        name: g.name,
        date: new Date(g.lastPlayed).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        hours30: fmtHours(totalSecs30),
        hours90: fmtHours(totalSecs90)
      }));

    res.json({
      displayName: user.display_name,
      followers,
      avgViewers,
      peakViewers: '—',
      periods,
      recentGames,
      url: `https://twitchtracker.com/${username}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
