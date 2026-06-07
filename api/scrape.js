module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'No username provided' });

  const CLIENT_ID = 'ocqpd0b51d5ueh3ge3izu0r5450dup';
  const CLIENT_SECRET = 'vlm9l7epva8m7b8133oz509xumiclz';

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`
    });
    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;

    const headers = {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${access_token}`
    };

    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, { headers });
    const userData = await userRes.json();
    if (!userData.data?.length) return res.status(404).json({ error: 'Streamer not found' });
    const user = userData.data[0];

    const followRes = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}&first=1`, { headers });
    const followData = await followRes.json();
    const followers = followData.total != null ? followData.total.toLocaleString() : '—';

    const now = new Date();
    const starts = {
      '30': new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      '60': new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
      '90': new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const vRes = await fetch(`https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=100`, { headers });
    const vData = await vRes.json();
    const allVideos = vData.data || [];

    function parseDuration(dur) {
      const m = dur.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
      if (!m) return 0;
      return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + (parseInt(m[3]||0));
    }

    function calcStats(videos, days) {
      const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
      const filtered = videos.filter(v => new Date(v.created_at) >= cutoff);
      if (!filtered.length) return { broadcastTime: '0h 0m', activeDays: '0 / wk', hoursWatched: '—' };
      let totalSecs = 0;
      const activeDaySet = new Set();
      for (const v of filtered) {
        totalSecs += parseDuration(v.duration);
        activeDaySet.add(v.created_at.slice(0, 10));
      }
      const totalHours = Math.floor(totalSecs / 3600);
      const totalMins = Math.floor((totalSecs % 3600) / 60);
      const weeksInPeriod = days / 7;
      const activeDaysPerWeek = (activeDaySet.size / weeksInPeriod).toFixed(1);
      return {
        broadcastTime: `${totalHours}h ${totalMins}m`,
        activeDays: `${activeDaysPerWeek} / wk`,
        hoursWatched: '—'
      };
    }

    const periods = [
      { days: '30', ...calcStats(allVideos, 30) },
      { days: '60', ...calcStats(allVideos, 60) },
      { days: '90', ...calcStats(allVideos, 90) },
    ];

    const horrorKeywords = ['horror','resident evil','silent hill','outlast','amnesia','visage','phasmophobia','alien isolation','until dawn','soma','layers of fear','little nightmares','fnaf','five nights','lethal company','content warning','devour','labyrinthine','granny','poppy','doors','forewarned','puppet combo'];

    const gameIds = [...new Set(allVideos.map(v => v.game_id).filter(Boolean))];
    let horrorGames = [];

    if (gameIds.length) {
      const gameRes = await fetch(`https://api.twitch.tv/helix/games?${gameIds.slice(0,100).map(id=>`id=${id}`).join('&')}`, { headers });
      const gameData = await gameRes.json();
      const nameMap = {};
      for (const g of gameData.data || []) nameMap[g.id] = g.name;

      const seen = new Set();
      for (const v of allVideos) {
        if (horrorGames.length >= 5) break;
        const name = nameMap[v.game_id];
        if (name && !seen.has(name) && horrorKeywords.some(k => name.toLowerCase().includes(k))) {
          seen.add(name);
          horrorGames.push({
            name,
            date: new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
          });
        }
      }
    }

    const streamRes = await fetch(`https://api.twitch.tv/helix/streams?user_id=${user.id}`, { headers });
    const streamData = await streamRes.json();
    const liveViewers = streamData.data?.[0]?.viewer_count;
    const avgViewers = liveViewers != null ? liveViewers.toLocaleString() : '—';

    res.json({
      displayName: user.display_name,
      followers,
      avgViewers,
      peakViewers: '—',
      periods,
      horrorGames,
      url: `https://twitchtracker.com/${username}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
