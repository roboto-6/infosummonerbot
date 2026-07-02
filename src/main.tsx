import { Devvit, SettingScope } from '@devvit/public-api';

/**
 * ============================================================================
 * INFO SUMMONER BOT
 * ============================================================================
 * Lets moderators define "trigger" commands (e.g. "!caresheet") with canned
 * text responses. Any user can summon a response by commenting the trigger
 * word on a post. A public "Command Dictionary" post lists every available
 * command for reference.
 *
 * Data model:
 *  - Commands + response text live in App Settings as one JSON blob
 *    (setting name: "bot_responses"). Format: { "trigger": "response text" }
 *  - Redis holds only small runtime bookkeeping: per-post cooldowns, ping
 *    counts, and the dictionary post's ID + its per-command comment IDs.
 *
 * ENVIRONMENT NOTE:
 * This project pins "@devvit/public-api" to 0.13.6 in package.json.
 * @devvit/public-api@0.13.6 removed the interactive Blocks custom-post
 * system entirely (addCustomPostType stopped working, and the hooks -
 * useAsync, useState, etc. - it depended on were removed outright). Do NOT
 * bump @devvit/public-api past 0.13.6 without testing.
 *
 * The dictionary post itself was deliberately kept as a plain text post
 * (not a custom post type) specifically to avoid that broken system - see
 * the "Update Command Dictionary" menu item below. A brief attempt was made
 * to migrate to Devvit Web (a separate, newer post/server architecture)
 * instead, but mixing Devvit Web's "post"/"server" config with this file's
 * "blocks" config in the same devvit.json broke post rendering entirely
 * (confirmed via testing, not just suspected) - so that path was abandoned
 * in favor of this simpler, fully-working plain-text-post approach.
 *
 * Longer term, Blocks itself is being phased out platform-wide in favor of
 * Devvit Web, and a full migration of this entire file (settings, menu
 * items, the comment trigger) off Blocks will likely be necessary
 * eventually. That's a deliberately deferred, separate future project, not
 * something to bundle into small fixes - addSettings/addMenuItem/addTrigger
 * (used throughout this file) are still working and officially supported
 * for now.
 * ============================================================================
 */

// Enable the Reddit API (posting/commenting/etc.) and Redis (key-value storage)
Devvit.configure({
  redditAPI: true,
  redis: true,
});

// ============================================================================
// APP SETTINGS
// Configured by moderators/installers from the app's settings page.
// ============================================================================
Devvit.addSettings([
  {
    // Purely informational - this field isn't read anywhere in the bot's
    // code. It exists only to give the command builder link its own
    // clearly separated, easy-to-copy spot on the settings page, since
    // Devvit's helpText doesn't render line breaks or clickable links well
    // enough to bury a URL inside a longer paragraph. Safe if a mod edits
    // or clears it - nothing depends on this value.
    type: 'string',
    name: 'command_builder_link',
    label: 'Command Builder Tool',
    helpText: 'Use this link to your command list visually, then paste the resulting JSON into "Bot Responses" box below.',
    defaultValue: 'https://roboto-6.github.io/infosummonerbot/command-builder.html',
    scope: SettingScope.Installation,
  },
  {
    // The master list of commands. Each entry can be either:
    //  - A plain string response (no category - shows as "Uncategorized")
    //  - An object { "category": "...", "text": "..." } for a categorized
    //    response, used to group commands in the dictionary post
    // Both forms can be mixed freely in the same JSON blob, so existing
    // plain-string commands never need to be touched to add categories to
    // new (or individually-migrated) ones.
    type: 'paragraph',
    name: 'bot_responses',
    label: 'Bot Responses (JSON)',
    helpText: 'Configure bot responses in JSON format. Plain response: {"caresheet": "Here is the care guide..."}. Categorized response (for grouping in the dictionary post): {"ich": {"category": "Diseases", "text": "..."}}. Both forms can be mixed in the same list.\n\nResponse text supports full markdown including links, bold, italic, lists, etc.',
    scope: SettingScope.Installation,
    // Validates JSON as it's saved, so bad input is caught immediately
    // rather than silently producing zero commands later at runtime.
    onValidate: ({ value }) => {
      if (!value) return; // Empty is okay

      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        return 'Invalid JSON format';
      }

      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Must be a JSON object with trigger names as keys';
      }

      // Each entry must be a string, or a {category?, text} object with a
      // string "text" field - catch typos/malformed entries at save time.
      for (const [trigger, entry] of Object.entries(parsed)) {
        const isPlainString = typeof entry === 'string';
        const isCategorizedObject =
          typeof entry === 'object' &&
          entry !== null &&
          !Array.isArray(entry) &&
          typeof (entry as any).text === 'string';

        if (!isPlainString && !isCategorizedObject) {
          return `"${trigger}" must be either a plain string, or an object with a "text" field (and optional "category" field)`;
        }
      }
    },
  },
  {
    // The character that precedes a command, e.g. "!" in "!caresheet".
    type: 'string',
    name: 'summon_indicator',
    label: 'Summon Indicator',
    helpText: 'The character used to trigger the bot (e.g., !, $, %, etc.). Users will type this before the command.',
    defaultValue: '!',
    scope: SettingScope.Installation,
    onValidate: ({ value }) => {
      if (!value || value.length !== 1) {
        return 'Must be a single character';
      }
      if (/[a-zA-Z0-9]/.test(value)) {
        return 'Cannot use letters or numbers as the indicator';
      }
    },
  },
  {
    // If on, a given trigger can only fire once per post - stops the same
    // response from being spammed repeatedly on one thread.
    type: 'boolean',
    name: 'enable_cooldown',
    label: 'Enable Trigger Cooldown',
    helpText: 'If enabled, each trigger can only be used once per post. Disable to allow unlimited uses.',
    defaultValue: true,
    scope: SettingScope.Installation,
  },
  {
    // Caps how many times any single user can be pinged by the bot within
    // one post, across all triggers combined.
    type: 'number',
    name: 'max_pings_per_user',
    label: 'Max Pings Per User Per Post',
    helpText: 'Maximum number of times the same user can be pinged by the bot in a single post. Set to 0 for unlimited.',
    defaultValue: 0,
    scope: SettingScope.Installation,
    onValidate: ({ value }) => {
      if (value < 0) {
        return 'Must be 0 or greater';
      }
    },
  },
]);

/**
 * A single entry in "bot_responses": either a plain response string
 * (uncategorized), or an object with the response text plus an optional
 * category used to group commands in the dictionary post.
 */
type ResponseEntry = string | { category?: string; text: string };

/**
 * Reads and parses the raw "bot_responses" setting, before flattening.
 * Returns {} (never throws/nulls) if the setting is empty or malformed.
 * Both getResponses() and getCategories() below derive from this single
 * parse, so the two stay perfectly in sync automatically - there's no
 * separate settings field to keep matched up by hand.
 */
async function getRawResponses(context: any): Promise<Record<string, ResponseEntry>> {
  const settings = await context.settings.get('bot_responses');
  if (!settings) return {};

  try {
    return JSON.parse(settings);
  } catch {
    return {};
  }
}

/**
 * Flattens "bot_responses" down to trigger -> response text, regardless of
 * whether each entry was written as a plain string or a categorized object.
 * This is what the comment-matching logic and "View Bot Responses" menu
 * item use - they don't care about categories, just trigger -> text.
 */
async function getResponses(context: any): Promise<Record<string, string>> {
  const raw = await getRawResponses(context);
  const flat: Record<string, string> = {};

  for (const [trigger, entry] of Object.entries(raw)) {
    flat[trigger] = typeof entry === 'string' ? entry : entry.text;
  }

  return flat;
}

/**
 * Extracts trigger -> category from "bot_responses", for entries that
 * specified one. Triggers written as plain strings (or as an object with no
 * "category" field) simply won't appear here - the dictionary post treats
 * any trigger missing from this map as "Uncategorized".
 */
async function getCategories(context: any): Promise<Record<string, string>> {
  const raw = await getRawResponses(context);
  const categories: Record<string, string> = {};

  for (const [trigger, entry] of Object.entries(raw)) {
    if (typeof entry === 'object' && entry.category) {
      categories[trigger] = entry.category;
    }
  }

  return categories;
}

// ============================================================================
// MODERATOR MENU ACTIONS
// ============================================================================

/**
 * Quick way for a mod to see the current command list without digging
 * through the settings page. Shows a toast + logs full detail to the
 * console (visible via `devvit logs`).
 */
Devvit.addMenuItem({
  label: 'View Bot Responses',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { ui } = context;
    const responses = await getResponses(context);
    const triggers = Object.keys(responses);

    if (triggers.length === 0) {
      ui.showToast('No responses configured yet. Go to App Settings to add some!');
      return;
    }

    const list = triggers.map(t => `!${t}`).join(', ');
    ui.showToast(`${triggers.length} Response(s): ${list}\n\nGo to App Settings to edit.`);
    console.log('=== ALL BOT RESPONSES ===');
    triggers.forEach(trigger => {
      console.log(`!${trigger}: ${responses[trigger]}`);
    });
    console.log('=========================');
  },
});

/**
 * Convenience shortcut that logs a direct link to this app's settings page
 * for the current subreddit, so mods don't have to hunt for it manually.
 */
Devvit.addMenuItem({
  label: 'Manage Bot Responses',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { ui } = context;
    const subreddit = await context.reddit.getCurrentSubreddit();
    const settingsUrl = `https://developers.reddit.com/r/${subreddit.name}/apps/infosummonerbot`;

    ui.showToast(`Opening settings page for ${subreddit.name}...`);

    // Log the URL for easy access
    console.log(`Settings page: ${settingsUrl}`);
  },
});

/**
 * Builds (or rebuilds) the public "Command Dictionary" post + its supporting
 * comments. Run this any time commands are added/changed in settings, to
 * refresh what's shown in the dictionary post.
 *
 * This is a plain text post, not a custom/interactive post type - its body
 * is a categorized, linked index of every command (reusing the same link
 * format as the "!command-list" auto-generated command below), and each
 * command's full response text lives in its own comment beneath the post.
 * A plain text post has no fixed-height canvas or scrolling limitation,
 * unlike a Blocks custom post - it just scrolls like any normal post.
 *
 * Flow:
 *  1. Reuse the existing dictionary post if we have one saved in Redis and
 *     it still exists / hasn't been removed. Otherwise create a new one.
 *  2. Delete old per-command comments, then post fresh ones holding each
 *     command's full response text.
 *  3. Edit the post body itself to a categorized list of links to those
 *     comments.
 *  4. Lock the post so only the bot's comments live there.
 */
Devvit.addMenuItem({
  label: 'Update Command Dictionary',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { ui, redis, reddit } = context;

    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const responses = await getResponses(context);
      const categories = await getCategories(context);
      const triggers = Object.keys(responses).sort();

      if (triggers.length === 0) {
        ui.showToast('No responses configured. Add some in settings first.');
        return;
      }

      // Check if we already have a dictionary post from a previous run
      let existingPostId = await redis.get('dictionary_post_id');
      let dictionaryPost;
      let needsNewPost = false;

      if (existingPostId) {
        try {
          dictionaryPost = await reddit.getPostById(existingPostId);

          if (dictionaryPost.removed) {
            console.log('Dictionary post was removed, creating new one');
            needsNewPost = true;
          } else {
            await dictionaryPost.unlock();

            // Delete old per-command comments (with delays to avoid rate
            // limiting) before posting fresh ones.
            const oldCommentIds = await redis.hGetAll('comment_ids');
            const oldIds = Object.values(oldCommentIds);
            for (let i = 0; i < oldIds.length; i++) {
              try {
                if (i > 0) {
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                }
                const comment = await reddit.getCommentById(oldIds[i]);
                await comment.delete();
              } catch (e) {
                console.log(`Could not delete comment ${oldIds[i]}: ${e}`);
              }
            }
            if (oldIds.length > 0) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          }
        } catch (e) {
          console.log(`Dictionary post not found: ${e}`);
          needsNewPost = true;
        }
      } else {
        needsNewPost = true;
      }

      if (needsNewPost) {
        dictionaryPost = await reddit.submitPost({
          title: '📖 Bot Command Dictionary',
          subredditName: subreddit.name,
          text: 'Generating dictionary...',
        });

        await redis.set('dictionary_post_id', dictionaryPost.id);
        await redis.del('comment_ids');
      }

      if (!dictionaryPost) {
        throw new Error('Dictionary post is unexpectedly missing after create/reuse step');
      }

      // Post one comment per command holding its full response text.
      const newCommentIds: Record<string, string> = {};

      for (let i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        const response = responses[trigger];
        const commentText = `## ${trigger}\n\n${response}`;

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 6000));
        }

        const comment = await dictionaryPost.addComment({ text: commentText });
        newCommentIds[trigger] = comment.id;
      }

      await redis.hSet('comment_ids', newCommentIds);

      // Edit the post body to a categorized, linked index of all commands.
      const body = buildDictionaryPostBody(
        responses,
        categories,
        newCommentIds,
        subreddit.name,
        dictionaryPost.id
      );
      await dictionaryPost.edit({ text: body });

      await dictionaryPost.lock();

      ui.showToast(`Dictionary updated with ${triggers.length} commands`);
    } catch (error) {
      console.error('Error updating dictionary:', error);
      ui.showToast('Error updating dictionary. Check logs.');
    }
  },
});

/**
 * Builds the categorized markdown body for the dictionary post itself: one
 * "## Category" heading per category, each followed by a bulleted, linked
 * list of its commands (reusing buildCommandListMarkdown, defined below).
 * Categories are sorted alphabetically, with "Uncategorized" always last.
 */
function buildDictionaryPostBody(
  responses: Record<string, string>,
  categories: Record<string, string>,
  commentIds: Record<string, string>,
  subredditName: string,
  dictionaryPostId: string
): string {
  const UNCATEGORIZED = 'Uncategorized';
  const grouped: Record<string, string[]> = {};

  for (const trigger of Object.keys(responses)) {
    const category = categories[trigger] || UNCATEGORIZED;
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(trigger);
  }

  const categoryNames = Object.keys(grouped).sort((a, b) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b);
  });

  const sections = categoryNames.map((category) => {
    const list = buildCommandListMarkdown(grouped[category], commentIds, subredditName, dictionaryPostId);
    return `## ${category}\n\n${list}`;
  });

  return sections.join('\n\n');
}


// ============================================================================
// AUTO-GENERATED "LIST" COMMANDS
// ============================================================================
/**
 * Two trigger names work automatically, without ever being added to
 * "bot_responses":
 *  - "command-list": replies with a bulleted, linked list of every command
 *  - the slug of each category in use (e.g. "diseases" for a "Diseases"
 *    category): replies with the same style of list, scoped to just that
 *    category
 * These are pure fallbacks - if a mod ever configures an actual command in
 * "bot_responses" using one of these exact names, that real command is used
 * instead and the auto-generated one for that name is skipped entirely.
 */
const COMMAND_LIST_TRIGGER = 'command-list';

/**
 * Turns a category name into a safe, lowercase, hyphenated trigger word,
 * e.g. "Tank Setup" -> "tank-setup". Used to derive each category's
 * auto-generated list-command name from its display name in settings.
 */
function slugifyCategory(category: string): string {
  return category
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a plain markdown bulleted list linking each given trigger to its
 * full-text comment in the dictionary post - just "- [!trigger](url)" per
 * line, sorted alphabetically, no extra detail. Triggers that don't have a
 * posted comment yet are silently skipped rather than showing a dead link.
 */
function buildCommandListMarkdown(
  triggers: string[],
  commentIds: Record<string, string>,
  subredditName: string,
  dictionaryPostId: string
): string {
  const cleanPostId = dictionaryPostId.replace(/^t3_/, '');
  const lines: string[] = [];

  for (const trigger of [...triggers].sort()) {
    const commentId = commentIds[trigger];
    if (!commentId) continue; // no comment posted for this one yet - skip it
    const cleanCommentId = commentId.replace(/^t1_/, '');
    const url = `https://www.reddit.com/r/${subredditName}/comments/${cleanPostId}/comment/${cleanCommentId}/`;
    lines.push(`- [!${trigger}](${url})`);
  }

  return lines.join('\n');
}

/**
 * Fetches everything needed (dictionary post ID, comment ID map, subreddit
 * name) and builds the reply text for a "list" command covering the given
 * set of triggers. Returns a friendly message instead of an empty list if
 * the dictionary post hasn't been generated yet.
 */
async function buildReservedListResponse(context: any, triggersToList: string[]): Promise<string> {
  const { redis, reddit } = context;

  const dictionaryPostId = await redis.get('dictionary_post_id');
  if (!dictionaryPostId) {
    return 'No command list is available yet - ask a moderator to run "Update Command Dictionary".';
  }

  const commentIds = await redis.hGetAll('comment_ids');
  const subreddit = await reddit.getCurrentSubreddit();
  const list = buildCommandListMarkdown(triggersToList, commentIds || {}, subreddit.name, dictionaryPostId);

  if (!list) {
    return 'No command list is available yet - ask a moderator to run "Update Command Dictionary".';
  }

  return `Available commands:\n\n${list}`;
}

// ============================================================================
// COMMENT LISTENER - the core "summoning" behavior
// ============================================================================
/**
 * Fires on every new comment for this install. Scans the comment for one or
 * more trigger words and replies with the matching configured response,
 * optionally pinging the OP or whoever the commenter replied to.
 * (Unchanged from the working version - no bug found here.)
 */
Devvit.addTrigger({
  event: 'CommentCreate',
  onEvent: async (event, context) => {
    const { reddit, settings } = context;

    if (!event.comment?.id) {
      console.log('No comment ID in event');
      return;
    }

    const comment = await reddit.getCommentById(event.comment.id);
    const commentBody = comment.body.toLowerCase();

    // Get settings
    const summonIndicator = (await settings.get('summon_indicator')) || '!';
    const cooldownEnabled = (await settings.get('enable_cooldown')) ?? true;
    const maxPingsPerUser = (await settings.get('max_pings_per_user')) || 0;

    // Find every word that starts with the summon indicator (e.g. "!caresheet")
    // and extract just the command part after the indicator. Hyphens are
    // allowed (not just letters/digits/underscore) so multi-word trigger
    // names like "!command-list" or a category slug like "!tank-setup"
    // match in full instead of getting cut off at the hyphen.
    const words = commentBody.split(/\s+/);
    const triggers: string[] = [];

    for (const word of words) {
      if (word.startsWith(summonIndicator)) {
        const trigger = word.substring(summonIndicator.length).match(/^[\w-]+/);
        if (trigger) {
          triggers.push(trigger[0]);
        }
      }
    }

    if (triggers.length === 0) return;

    // Ping targeting: @op pings the post author, @above pings whoever this
    // comment is replying to. Neither present -> defaults to pinging OP.
    const pingOP = commentBody.includes('@op');
    const pingAbove = commentBody.includes('@above');

    // Get all responses from settings
    const allResponses = await getResponses(context);

    // Group triggers by category, so an auto-generated "!<category-slug>"
    // command (see AUTO-GENERATED "LIST" COMMANDS above) knows which
    // triggers belong to it. Built fresh per comment since categories can
    // change at any time in settings.
    const categories = await getCategories(context);
    const categorySlugToTriggers: Record<string, string[]> = {};
    for (const [cmdTrigger, category] of Object.entries(categories)) {
      const slug = slugifyCategory(category);
      if (!categorySlugToTriggers[slug]) categorySlugToTriggers[slug] = [];
      categorySlugToTriggers[slug].push(cmdTrigger);
    }

    if (Object.keys(allResponses).length === 0) {
      console.log('No responses configured');
      return;
    }

    // Process each trigger found in the comment
    for (const trigger of triggers) {
      // A manually-configured command always wins if one exists under this
      // exact name. Otherwise, fall back to the auto-generated list
      // commands: the full command list, then a category-scoped list.
      let response: string | undefined = allResponses[trigger];

      if (!response && trigger === COMMAND_LIST_TRIGGER) {
        response = await buildReservedListResponse(context, Object.keys(allResponses));
      }

      if (!response && categorySlugToTriggers[trigger]) {
        response = await buildReservedListResponse(context, categorySlugToTriggers[trigger]);
      }

      if (response) {
        const { redis } = context;

        // Check cooldown if enabled - skip if this trigger already fired
        // once on this post.
        if (cooldownEnabled) {
          const cooldownKey = `used:${comment.postId}:${trigger}`;
          const alreadyUsed = await redis.get(cooldownKey);

          if (alreadyUsed) {
            console.log(`Trigger ${summonIndicator}${trigger} already used on post ${comment.postId}, skipping`);
            continue;
          }
        }

        // Determine who to ping
        let targetUsername = '';
        let pingText = '';

        if (pingOP) {
          const post = await reddit.getPostById(comment.postId);
          targetUsername = post.authorName;
          pingText = `^(Pinging OP:) u/${targetUsername}`;
        } else if (pingAbove) {
          if (comment.parentId) {
            try {
              const parentComment = await reddit.getCommentById(comment.parentId);
              targetUsername = parentComment.authorName;
              pingText = `^(Pinging:) u/${targetUsername}`;
            } catch (e) {
              console.log('Could not get parent comment author');
              pingText = '^(Could not ping parent comment author)';
            }
          } else {
            // Top-level comment with no parent to ping "above" - fall back to OP.
            const post = await reddit.getPostById(comment.postId);
            targetUsername = post.authorName;
            pingText = `^(Pinging OP:) u/${targetUsername}`;
          }
        } else {
          // Default behavior when no @op/@above specified: ping OP.
          const post = await reddit.getPostById(comment.postId);
          targetUsername = post.authorName;
          pingText = `^(Pinging OP:) u/${targetUsername}`;
        }

        // Check max pings per user if enabled
        if (maxPingsPerUser > 0 && targetUsername) {
          const pingCountKey = `pings:${comment.postId}:${targetUsername}`;
          const currentPings = parseInt((await redis.get(pingCountKey)) || '0');

          if (currentPings >= maxPingsPerUser) {
            console.log(`User ${targetUsername} already pinged ${currentPings} times in post ${comment.postId}, skipping`);
            continue;
          }

          // Increment ping count
          await redis.set(pingCountKey, (currentPings + 1).toString());
        }

        // Build the response with ping
        const replyText = `${response}\n\n---\n\n${pingText}`;

        // Reply to the comment
        await comment.reply({
          text: replyText,
        });

        // Mark this trigger as used for this post (if cooldown enabled)
        if (cooldownEnabled) {
          await redis.set(`used:${comment.postId}:${trigger}`, 'true');
        }

        console.log(`Bot responded to ${summonIndicator}${trigger} in comment ${comment.id}`);
      }
    }
  },
});

export default Devvit;