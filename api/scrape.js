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
      const h = Math.floor(secs/3600), mn = Math.floor((secs%3600)/60);
      return h > 0 ? `${h}h ${mn}m` : `${mn}m`;
    }

    function calcPeriod(days) {
      const cutoff = Date.now() - days * 864e5;
      const vids = allVideos.filter(v => new Date(v.created_at).getTime() >= cutoff);
      if (!vids.length) return { broadcastTime: '0h 0m', activeDays: '0.0 / wk', hoursPerWeek: '0.0 / wk' };
      const secs = vids.reduce((a, v) => a + parseSecs(v.duration), 0);
      const daySet = new Set(vids.map(v => v.created_at.slice(0,10)));
      const weeks = days / 7;
      return {
        broadcastTime: fmtHours(secs),
        activeDays: `${(daySet.size / weeks).toFixed(1)} / wk`,
        hoursPerWeek: `${(secs / 3600 / weeks).toFixed(1)} / wk`,
      };
    }

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

    const clipGameIds = [...new Set(clips.map(c => c.game_id).filter(Boolean))].slice(0, 100);
    let clipNameMap = {};
    if (clipGameIds.length) {
      const gRes = await fetch(`https://api.twitch.tv/helix/games?${clipGameIds.map(id=>`id=${id}`).join('&')}`, { headers });
      const gData = await gRes.json();
      clipNameMap = Object.fromEntries((gData.data||[]).map(g => [g.id, g.name]));
    }

    const channelRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${user.id}`, { headers });
    const channelData = await channelRes.json();
    const currentGame = channelData.data?.[0];

    // Build known games list with timestamps from clips
    const knownGames = {};
    if (currentGame?.game_name) {
      knownGames[currentGame.game_name] = { name: currentGame.game_name, lastPlayed: new Date().toISOString() };
    }
    for (const c of clips) {
      const name = clipNameMap[c.game_id];
      if (!name) continue;
      if (!knownGames[name]) knownGames[name] = { name, lastPlayed: c.created_at };
      if (new Date(c.created_at) > new Date(knownGames[name].lastPlayed)) {
        knownGames[name].lastPlayed = c.created_at;
      }
    }

    // Build 6-month timeline — one entry per month for last 6 months
    const now = new Date();
    const monthTimeline = [];

    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthStart = new Date(year, month, 1).getTime();
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59).getTime();
      const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      // Find games played this month from clips
      const gamesThisMonth = {};
      for (const c of clips) {
        const ts = new Date(c.created_at).getTime();
        if (ts < monthStart || ts > monthEnd) continue;
        const name = clipNameMap[c.game_id];
        if (!name) continue;
        if (!gamesThisMonth[name]) gamesThisMonth[name] = { name, secs: 0 };
      }

      // Estimate hours per game this month by matching video titles
      for (const gameName of Object.keys(gamesThisMonth)) {
        const keyword = gameName.toLowerCase();
        for (const v of allVideos) {
          const ts = new Date(v.created_at).getTime();
          if (ts < monthStart || ts > monthEnd) continue;
          if ((v.title || '').toLowerCase().includes(keyword)) {
            gamesThisMonth[gameName].secs += parseSecs(v.duration);
          }
        }
      }

      // Also catch any games from video titles that weren't in clips
      for (const v of allVideos) {
        const ts = new Date(v.created_at).getTime();
        if (ts < monthStart || ts > monthEnd) continue;
        const title = v.title || '';
        // Check if any known game name appears in the title
        for (const gameName of Object.keys(knownGames)) {
          if (title.toLowerCase().includes(gameName.toLowerCase())) {
            if (!gamesThisMonth[gameName]) gamesThisMonth[gameName] = { name: gameName, secs: 0 };
            gamesThisMonth[gameName].secs += parseSecs(v.duration);
          }
        }
      }

      const gamesList = Object.values(gamesThisMonth)
        .sort((a, b) => b.secs - a.secs)
        .map(g => ({ name: g.name, hours: fmtHours(g.secs) }));

      // Calculate total stream hours this month
      const monthVideos = allVideos.filter(v => {
        const ts = new Date(v.created_at).getTime();
        return ts >= monthStart && ts <= monthEnd;
      });
      const totalSecs = monthVideos.reduce((a, v) => a + parseSecs(v.duration), 0);

      monthTimeline.push({
        label: monthLabel,
        totalHours: fmtHours(totalSecs),
        streamDays: new Set(monthVideos.map(v => v.created_at.slice(0,10))).size,
        games: gamesList
      });
    }

    res.json({
      displayName: user.display_name,
      followers,
      avgViewers,
      peakViewers: '—',
      periods,
      monthTimeline,
      url: `https://twitchtracker.com/${username}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
