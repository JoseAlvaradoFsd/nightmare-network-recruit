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

    // Get all unique game_ids from videos
    const rawGameIds = [...new Set(allVideos.map(v => v.game_id).filter(Boolean))];

    // Look up game names from Twitch for all game_ids found in VODs
    let nameMap = {};
    if (rawGameIds.length) {
      // Fetch in batches of 100
      for (let i = 0; i < rawGameIds.length; i += 100) {
        const batch = rawGameIds.slice(i, i + 100);
        const gRes = await fetch(`https://api.twitch.tv/helix/games?${batch.map(id => `id=${id}`).join('&')}`, { headers });
        const gData = await gRes.json();
        for (const g of gData.data || []) nameMap[g.id] = g.name;
      }
    }

    // If videos don't have game_id, fetch each video individually to get category
    // Twitch's /videos endpoint sometimes omits game_id — use /channels instead
    const videosWithoutGame = allVideos.filter(v => !v.game_id);
    if (videosWithoutGame.length > 0 && rawGameIds.length === 0) {
      // Fall back: get channel's game history via schedule or stream markers
      // Use the channel endpoint to at least get current game
      const channelRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${user.id}`, { headers });
      const channelData = await channelRes.json();
      const ch = channelData.data?.[0];
      if (ch?.game_id && ch?.game_name) {
        nameMap[ch.game_id] = ch.game_name;
        // Assign current game to most recent videos that lack game_id
        for (const v of allVideos.slice(0, 5)) {
          if (!v.game_id) v.game_id = ch.game_id;
        }
      }

      // Also pull from clips which always have game_id
      let clips = [];
      let clipCursor = null;
      for (let i = 0; i < 4; i++) {
        const clipUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=100${clipCursor ? '&after=' + clipCursor : ''}`;
        const cRes = await fetch(clipUrl, { headers });
        const cData = await cRes.json();
        clips = clips.concat(cData.data || []);
        clipCursor = cData.pagination?.cursor;
        if (!clipCursor || clips.length >= 400) break;
      }

      const clipGameIds = [...new Set(clips.map(c => c.game_id).filter(Boolean))];
      if (clipGameIds.length) {
        const gRes = await fetch(`https://api.twitch.tv/helix/games?${clipGameIds.slice(0,100).map(id=>`id=${id}`).join('&')}`, { headers });
        const gData = await gRes.json();
        for (const g of gData.data || []) nameMap[g.id] = g.name;

        // Match clips to videos by date to assign game_id to videos
        for (const v of allVideos) {
          if (v.game_id) continue;
          const vDate = v.created_at.slice(0, 10);
          const matchingClip = clips.find(c => c.created_at.slice(0, 10) === vDate && c.game_id);
          if (matchingClip) v.game_id = matchingClip.game_id;
        }

        // Also try matching by week
        for (const v of allVideos) {
          if (v.game_id) continue;
          const vTime = new Date(v.created_at).getTime();
          const weekRange = 7 * 864e5;
          const matchingClip = clips.find(c => {
            const cTime = new Date(c.created_at).getTime();
            return Math.abs(cTime - vTime) < weekRange && c.game_id;
          });
          if (matchingClip) v.game_id = matchingClip.game_id;
        }
      }
    }

    // Build 6-month timeline
    const now = new Date();
    const monthTimeline = [];

    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthStart = new Date(year, month, 1).getTime();
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59).getTime();
      const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      const monthVideos = allVideos.filter(v => {
        const ts = new Date(v.created_at).getTime();
        return ts >= monthStart && ts <= monthEnd;
      });

      const totalSecs = monthVideos.reduce((a, v) => a + parseSecs(v.duration), 0);
      const streamDays = new Set(monthVideos.map(v => v.created_at.slice(0,10))).size;

      // Build game map for this month using game_id from videos
      const gameMap = {};
      for (const v of monthVideos) {
        const name = nameMap[v.game_id] || null;
        if (!name) continue;
        if (!gameMap[name]) gameMap[name] = { name, secs: 0 };
        gameMap[name].secs += parseSecs(v.duration);
      }

      const games = Object.values(gameMap)
        .sort((a, b) => b.secs - a.secs)
        .map(g => ({ name: g.name, hours: fmtHours(g.secs) }));

      monthTimeline.push({
        label: monthLabel,
        totalHours: fmtHours(totalSecs),
        streamDays,
        games
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
