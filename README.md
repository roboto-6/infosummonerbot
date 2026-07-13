# Info Summoner Bot

A Reddit Devvit app that automatically responds to user summons with custom information. Perfect for providing frequently requested resources like information sheets, process overviews, phrase definitions, or FAQs.

## Features

- Responds automatically when users comment with trigger commands (e.g., `!caresheet`)
- Flexible pinging - tag the OP or the person being replied to
- Customizable summon indicator (use `!`, `$`, `%`, or any special character)
- Optional cooldown to prevent spam (can be toggled per subreddit)
- Full markdown support in responses (links, bold, lists, etc.)
- Multi-subreddit support - each community has independent settings
- Built-in !command-list and ![category] commands respond with the list of commands (or those in that category) with links to their dictionary page to streamline real-time bot access.
- Commands are case-insensitive, !command, !Command, and !CommaNd all work


## Configuration

**Manage responses:**
On your subreddit, click the 3-dot menu at the top. Scroll down and select "Manage Bot Responses". This will open your bot configuration page for that subreddit. 

Alternatively - 
Click on the app in the Installed Apps section of your subreddit, then scroll down to "My installations", or navigate directly to:
```
https://developers.reddit.com/r/YourSubredditName/apps/infosummonerbot
```
### Settings

**Dictionary Post Title**
Set a custom title for your automated dictionary post
- Leave as-is to use the default title

*Note:* You cannot edit the title of an existing dictionary post. When you run "Update Command Dictionary", the previous dictionary post will be deleted and a new one will be created.

**Dictionary Post Intro Text (optional)**
Space to add additional text above the full command dictionary. This space can be used to give users an introduction to the bot and your goals for it on the subreddit. This field is option and doesn't have to be used.

**Bot Responses (JSON)**
- Define your trigger-response pairs in JSON format
- Supports full markdown formatting including headers, links, lists, bold, italic, quotes, and more
- [Use our bot command generator tool](https://roboto-6.github.io/infosummonerbot/command-builder.html) to format your commands and responses for easier set-up
- Commands can be categorized to improve dictionary organization and user access. 

Example:
```json
{
  "ammoniapoisoning": {
    "category": "Diseases",
    "text": "Caused by high ammonia buildup, common in new or overstocked tanks. Symptoms: lethargy, staying near the surface, pale/irritated gills. Do an immediate 50% water change, then retest and repeat daily until ammonia reads 0ppm.\n\n[Full guide →](/r/bettafish/wiki/disease/#wiki_ammonia_poisoning)"
  },
  "caresheet": "# Bettafish Care Guide\n\n**Temperature:** 76-82°F\n\n**Diet:** \n- Pellets, fresh or frozen food\n- Feed every 1- times daily, an amount about the size of their eye\n\nFull guide: [care sheet](https://www.reddit.com/r/bettafish/comments/3ow6vz/info_betta_care_sheet/)\n\n*Questions? Ask in the comments!*",
  "cycling": {
    "category": "setup",
    "text": "## What is \"the cycle\"?\n\nThe cycle, or rather the nitrogen cycle, is something many betta owners aren’t educated on before owning a fish. It refers to the conversion of **ammonia → nitrite → nitrate** by beneficial bacteria (and archaea). Ammonia comes from waste — fish waste, leftover food, or decaying matter.\n\n> **Running a filter for 24 hours is not cycling**.  \n> Cycling means establishing beneficial bacteria that process waste.\n\nAmmonia and nitrite are toxic even at low levels. Nitrate is toxic over time (10–20 ppm+). Ideally, we introduce fish when no ammonia or nitrite are present. This takes 1–2 months of “feeding” an empty tank with pure ammonia or food and testing for ammonia, nitrite, and nitrate.\n\nSee [this link](https://www.fishkeeping.co.uk) for details on fishless cycling.\n\n---\n\n"
  }
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

### Applying configuration changes

1) Once you've changed your bot configurations, navigate back to your subreddit
2) Click the 3-dot icon at the top of the subreddit main page
3) Scroll towards the bottom of that menu and select "Update Command Dictionary"

The bot will refresh your command dictionary and update the dictionary post. New commands will be added (including their example comments) and removed commands (and their example comments), will be deleted. This process can sometimes take several minutes. 

If the update fails after multiple tries, delete your previous dictionary post and re-run "Update Command Dictionary". The generation of a new command dictionary can take several minutes and the dictionary may display "Generating Dictionary" while that process completes. 

## Usage

### For Users

**Basic summon:**
```
!ammoniapoisoning
```
This pings the post's OP by default.

**Ping the OP specifically:**
```
!ammoniapoisoning @OP
```

**Ping the person you're replying to:**
```
!ammoniapoisoning @above
```

### Example Interaction

**User comments:**
```
!ammoniapoisoning @OP
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
- `@OP` and `@above` work with any summon indicator
- Responses support full Reddit markdown syntax

## Troubleshooting

**Can't access settings:**
- Must be a moderator with full permissions
- Use the exact URL format with your subreddit name

**Trigger already used:**
- Cooldown is enabled - each trigger works once per post
- This is intentional to prevent spam
- Can be disabled in settings


## Support

For issues or questions, visit [r/infosummonerbot](https://www.reddit.com/r/infosummonerbot/) 

[See the full documentation](https://github.com/roboto-6/infosummonerbot)

# Change History

## 0.5.0
- Added dictionary title and body content fields to the config page
- Made command triggers case-insensitive
- Updated to use Reddit API 0.13.7


## 0.4.0
- Updated to use Reddit API 0.13.6
- Began the process of migrating from blocks to Devvit Web, removed deprecated hooks. 
- Replaced the custom post with a plain text post to better work across device types.

## 0.3.0
- Fixed the dictionary display feature
- Added the ability to categorize commands
- Added default !command-list command as well as the ability to use ![category] to view the list of commands within a category
- Created a JSON converter to make command generation easier

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