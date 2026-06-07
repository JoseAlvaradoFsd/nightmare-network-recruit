const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'No username provided' });

  try {
    const url = `https://twitchtracker.com/${username}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) throw new Error(`TwitchTracker returned ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);

    const displayName = $('.g-title').first().text().trim() || username;
    const followers = $('.followers .g-x-s-value').first().text().trim();
    const avgViewers = $('.average-viewers .g-x-s-value').first().text().trim();
    const peakViewers = $('.peak-viewers .g-x-s-value').first().text().trim();

    const periods = ['30', '60', '90'].map(days => {
      const sel = `.period-${days}`;
      return {
        days,
        broadcastTime: $(`${sel} .broadcast-time`).text().trim() || null,
        hoursWatched: $(`${sel} .hours-watched`).text().trim() || null,
        activeDays: $(`${sel} .active-days`).text().trim() || null,
      };
    });

    const horrorKeywords = ['horror','resident evil','silent hill','outlast','amnesia','visage','phasmophobia','alien isolation','until dawn','soma','layers of fear','little nightmares','fnaf','five nights','lethal company','content warning','devour','labyrinthine','granny','poppy','doors'];
    const horrorGames = [];
    $('table tr').each((_, row) => {
      if (horrorGames.length >= 5) return;
      const gameName = $(row).find('td a').first().text().trim();
      const date = $(row).find('td').first().text().trim();
      if (gameName && horrorKeywords.some(k => gameName.toLowerCase().includes(k))) {
        if (!horrorGames.find(g => g.name === gameName)) {
          horrorGames.push({ name: gameName, date });
        }
      }
    });

    res.json({ displayName, followers, avgViewers, peakViewers, periods, horrorGames, url });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
