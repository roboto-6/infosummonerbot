# Info Summoner Bot

A Reddit Devvit app that automatically responds to user summons with custom information. Perfect for providing frequently requested resources like care sheets, cycling guides, disease information, or FAQs.

## Features

- Responds automatically when users comment with trigger commands (e.g., `!caresheet`)
- Flexible pinging - tag the OP or the person being replied to
- Customizable summon indicator (use `!`, `$`, `%`, or any special character)
- Optional cooldown to prevent spam (can be toggled per subreddit)
- Limit pings per user per post
- Full markdown support in responses (links, bold, lists, etc.)
- Multi-subreddit support - each community has independent settings

## Installation

```bash
npm install -g devvit
devvit login
npm install
devvit upload
devvit install r/YourSubredditName
```

## Configuration

Access your bot's settings page at:
```
https://developers.reddit.com/r/YourSubredditName/apps/infosummonerbot
```

### Settings

**Bot Responses (JSON)**
- Define your trigger-response pairs in JSON format
- Supports full markdown formatting including headers, links, lists, bold, italic, quotes, and more

Example:
```json
{
  "ammoniapoisoning": "Ammonia poisoning in bettas occurs when toxic ammonia builds up from waste, overfeeding, or a **lack of an established nitrogen cycle**. Signs include gasping, red or inflamed gills, and lethargy. Prompt partial water changes, water conditioner, and cycling the tank aid recovery.\n\n[Read the full guide →](/r/bettafish/wiki/disease/#wiki_ammonia_posioning)",
  "caresheet": "Here is our community care sheet with helpful information...",
  "rules": "Please read our [community rules](https://reddit.com/r/yoursubreddit/wiki/rules)"
}
```

**Summon Indicator** (default: `!`)
- Choose what character triggers the bot
- Examples: `!`, `$`, `%`, `#`
- Users will type `{indicator}command` (e.g., `$caresheet`)

**Enable Trigger Cooldown** (default: ON)
- When enabled: Each trigger can only be used once per post
- When disabled: Unlimited trigger uses per post

**Max Pings Per User Per Post** (default: 0 = unlimited)
- Limit how many times the same user can be pinged in one post
- Example: Set to 2 to prevent ping spam

## Usage

### For Users

**Basic summon:**
```
!ammoniapoisoning
```
This pings the post's OP by default.

**Ping the OP specifically:**
```
!ammoniapoisoning .@OP
```

**Ping the person you're replying to:**
```
!ammoniapoisoning .@above
```

### For Moderators

**Manage responses:**
Click on the app in the Installed Apps section of your subreddit, then scroll down to "My installations", or navigate directly to:
```
https://developers.reddit.com/r/YourSubredditName/apps/infosummonerbot
```

## Example Interaction

**User comments:**
```
!ammoniapoisoning .@OP
```

**Bot replies:**
```
Ammonia poisoning in bettas occurs when toxic ammonia builds up from waste, overfeeding, or a **lack of an established nitrogen cycle**. Signs include gasping, red or inflamed gills, and lethargy. Prompt partial water changes, water conditioner, and cycling the tank aid recovery.

[Read the full guide →](/r/bettafish/wiki/disease/#wiki_ammonia_posioning)

---

^(Pinging OP:) u/OriginalPoster
```

## Notes

- Triggers are case-insensitive
- Each subreddit has independent configuration
- Responses persist across app restarts
- The summon indicator cannot be a letter or number
- `.@OP` and `.@above` work with any summon indicator
- Responses support full Reddit markdown syntax

## Multi-Subreddit Setup

Install the app on multiple subreddits:
```bash
devvit install r/subreddit1
devvit install r/subreddit2
```

Each subreddit will have its own:
- Unique responses
- Custom summon indicator
- Independent cooldown settings
- Separate ping limits

## Troubleshooting

**Bot not responding:**
- Check if responses are configured in settings
- Verify the correct summon indicator is being used
- Check logs: `devvit logs infosummonerbot`

**Can't access settings:**
- Must be a moderator with full permissions
- Use the exact URL format with your subreddit name

**Trigger already used:**
- Cooldown is enabled - each trigger works once per post
- This is intentional to prevent spam
- Can be disabled in settings

## Development

To view logs:
```bash
devvit logs infosummonerbot
```

To update the app:
```bash
devvit upload
```

## Support

For issues or questions, visit r/Devvit or check the documentation at developers.reddit.com

# Change History

## 0.2.10
- Fixed bug that created rate limit error when initializing the dictionary

## 0.2.0
- Added functionality to create a custom post on the installed subreddit to display command dictionary with references to command responses including the full markdown styling of those responses.  

## 0.1.2
- Updated to Devvit 0.12.3

## 0.1.1
- Published the app for broader use
## 0.0.16
- Updated README file
- Streamlined configuration inputs