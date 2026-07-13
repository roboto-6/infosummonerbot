import { Devvit, SettingScope } from '@devvit/public-api';

/**
 * ============================================================================
 * INFO SUMMONER BOT
 * ============================================================================
 * Mods define "trigger" commands (e.g. "!caresheet") with canned text
 * responses. Any user can summon a response by commenting the trigger word.
 * A public "Command Dictionary" post lists every command for reference.
 *
 * Data model:
 *  - Commands + responses: one JSON blob in settings ("bot_responses")
 *  - Redis: just runtime bookkeeping - cooldowns, ping counts, dictionary
 *    post ID + its per-command comment IDs
 *
 * Blocks itself is being phased out platform-wide (Devvit Web is the
 * replacement). Full migration off Blocks is a deferred future project -
 * addSettings/addMenuItem/addTrigger still work fine for now.
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
    // Informational only, not read by any code.
    // Gives the builder link its own copyable spot, since helpText doesn't
    // render line breaks/links well enough to bury a URL mid-paragraph.
    type: 'string',
    name: 'command_builder_link',
    label: 'Command Builder Tool',
    helpText: 'Use this link to your command list visually, then paste the resulting JSON into "Bot Responses" box below.',
    defaultValue: 'https://roboto-6.github.io/infosummonerbot/command-builder.html',
    scope: SettingScope.Installation,
  },
  {
    // Used when the dictionary post is (re)created. Reddit won't let a
    // post's title be edited after posting - changing this just triggers a
    // new post next time "Update Command Dictionary" runs.
    type: 'string',
    name: 'dictionary_post_title',
    label: 'Dictionary Post Title',
    helpText:
      'Title for the dictionary post. Note: Reddit doesn\'t allow editing a post\'s title after posting - changing this triggers the bot to automatically create a new dictionary post (replacing the old one) the next time "Update Command Dictionary" is run.',
    defaultValue: '📖 Bot Command Dictionary',
    scope: SettingScope.Installation,
    onValidate: ({ value }) => {
      if (!value || !value.trim()) {
        return 'Title cannot be empty';
      }
    },
  },
  {
    // Optional blurb above the category list - house rules, a wiki link,
    // whatever. Blank by default. Updates immediately on every run (unlike
    // the title).
    type: 'paragraph',
    name: 'dictionary_post_intro',
    label: 'Dictionary Post Intro Text (optional)',
    helpText: 'Optional text shown at the top of the Command Dictionary post, above the category list. Supports markdown. Leave blank for no intro text.',
    scope: SettingScope.Installation,
  },
  {
    // The command list. Each entry is either:
    //  - a plain string (uncategorized)
    //  - { category, text } (grouped in the dictionary post)
    // Both forms mix freely - existing plain entries never need touching.
    type: 'paragraph',
    name: 'bot_responses',
    label: 'Bot Responses (JSON)',
    helpText: 'Configure bot responses in JSON format. Plain response: {"caresheet": "Here is the care guide..."}. Categorized response (for grouping in the dictionary post): {"ich": {"category": "Diseases", "text": "..."}}. Both forms can be mixed in the same list.\n\nResponse text supports full markdown including links, bold, italic, lists, etc.',
    scope: SettingScope.Installation,
    // Catches bad JSON/malformed entries at save time, not runtime.
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
    // e.g. "!" in "!caresheet"
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
    // Once per post per trigger, if on - stops spam on one thread.
    type: 'boolean',
    name: 'enable_cooldown',
    label: 'Enable Trigger Cooldown',
    helpText: 'If enabled, each trigger can only be used once per post. Disable to allow unlimited uses.',
    defaultValue: true,
    scope: SettingScope.Installation,
  },
  {
    // Caps pings to one user per post, across all triggers.
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
 * One entry in "bot_responses": a plain response string (uncategorized), or
 * { category?, text } for a categorized one.
 */
type ResponseEntry = string | { category?: string; text: string };

/**
 * Parses raw "bot_responses". Returns {} if empty/malformed. getResponses()
 * and getCategories() both derive from this, so they stay in sync.
 *
 * Trigger keys keep whatever casing was typed ("ACF" stays "ACF" for
 * display) - matching against a comment is case-insensitive separately, via
 * findTriggerKey() below.
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
 * Case-insensitive key lookup - finds the actual (original-casing) trigger
 * key matching `lookupTrigger`, or undefined.
 */
function findTriggerKey(responses: Record<string, unknown>, lookupTrigger: string): string | undefined {
  const lower = lookupTrigger.toLowerCase();
  return Object.keys(responses).find((key) => key.toLowerCase() === lower);
}

/** Flattens "bot_responses" to trigger -> response text, categorized or not. */
async function getResponses(context: any): Promise<Record<string, string>> {
  const raw = await getRawResponses(context);
  const flat: Record<string, string> = {};

  for (const [trigger, entry] of Object.entries(raw)) {
    flat[trigger] = typeof entry === 'string' ? entry : entry.text;
  }

  return flat;
}

/**
 * Trigger -> category, for entries that have one. Anything missing here is
 * "Uncategorized" in the dictionary post.
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

/** Jumps a mod straight to this app's settings page for the subreddit. */
Devvit.addMenuItem({
  label: 'Manage Bot Responses',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { ui } = context;
    const subreddit = await context.reddit.getCurrentSubreddit();
    const settingsUrl = `https://developers.reddit.com/r/${subreddit.name}/apps/infosummonerbot`;

    ui.navigateTo(settingsUrl);
  },
});

/**
 * Builds/updates the public "Command Dictionary" post + its comments. Run
 * after adding/editing commands in settings.
 *
 * Plain text post, not a custom post type - no fixed height, no scroll
 * limit. Body is a categorized, linked index; each command's full text
 * lives in its own comment.
 *
 * Flow:
 *  - Reuse the existing post if the title still matches what's configured.
 *    A title change is the one thing that forces a new post - Reddit won't
 *    let you edit a post's title after the fact.
 *  - Diff comments against the current command list: edit in place, add
 *    only for new commands, delete only for removed ones. (Not a full
 *    delete-and-repost every time - that used to make even a one-command
 *    edit slow enough to risk timing out.)
 *  - Edit the post body to the categorized link list.
 *  - Lock the post.
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

      // Falls back to the default for installs from before this setting
      // existed, where the stored value may still be unset.
      const postTitle = (await context.settings.get('dictionary_post_title')) || '📖 Bot Command Dictionary';
      const introText = (await context.settings.get('dictionary_post_intro')) || '';

      if (triggers.length === 0) {
        ui.showToast('No responses configured. Add some in settings first.');
        return;
      }

      // Title change -> new post is the only forced-regen case; everything
      // else (add/edit/remove commands) reuses the post and diffs comments.
      const existingPostId = await redis.get('dictionary_post_id');
      const storedTitle = await redis.get('dictionary_post_title_used');
      let dictionaryPost;
      let needsNewPost = false;
      let oldCommentIds: Record<string, string> = {};

      if (existingPostId) {
        try {
          dictionaryPost = await reddit.getPostById(existingPostId);

          if (dictionaryPost.removed) {
            console.log('Dictionary post was removed, creating new one');
            needsNewPost = true;
          } else if (storedTitle !== null && storedTitle !== postTitle) {
            console.log(`Dictionary title changed ("${storedTitle}" -> "${postTitle}"), recreating post`);
            try {
              await dictionaryPost.delete();
            } catch (e) {
              console.log(`Could not delete old dictionary post: ${e}`);
            }
            needsNewPost = true;
          } else {
            // Same post, same title - reuse and diff comments below.
            await dictionaryPost.unlock();
            oldCommentIds = (await redis.hGetAll('comment_ids')) || {};
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
          title: postTitle,
          subredditName: subreddit.name,
          text: 'Generating dictionary...',
        });

        await redis.set('dictionary_post_id', dictionaryPost.id);
        await redis.set('dictionary_post_title_used', postTitle);
        await redis.del('comment_ids');
        oldCommentIds = {}; // Fresh post - nothing to diff against.
      }

      if (!dictionaryPost) {
        throw new Error('Dictionary post is unexpectedly missing after create/reuse step');
      }

      // Trigger no longer in settings -> delete its comment.
      const removedTriggers = Object.keys(oldCommentIds).filter((t) => !(t in responses));
      for (let i = 0; i < removedTriggers.length; i++) {
        try {
          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          const comment = await reddit.getCommentById(oldCommentIds[removedTriggers[i]]);
          await comment.delete();
        } catch (e) {
          console.log(`Could not delete comment for removed trigger "${removedTriggers[i]}": ${e}`);
        }
      }

      // Editing your own comment isn't rate-limited the way rapid-fire
      // new comments are - so edits run in parallel, no delay. This is
      // what matters most, since most commands already have a comment and
      // are just being edited. Only genuinely new ones hit the slower,
      // cautious sequential path below.
      const newCommentIds: Record<string, string> = {};
      const newTriggers: string[] = [];
      const editableTriggers = triggers.filter((trigger) => oldCommentIds[trigger]);

      const editResults = await Promise.allSettled(
        editableTriggers.map(async (trigger) => {
          const commentText = `## ${trigger}\n\n${responses[trigger]}`;
          const existingCommentId = oldCommentIds[trigger];
          const comment = await reddit.getCommentById(existingCommentId);
          await comment.edit({ text: commentText });
          return { trigger, commentId: existingCommentId };
        })
      );

      for (let i = 0; i < editResults.length; i++) {
        const result = editResults[i];
        const trigger = editableTriggers[i];

        if (result.status === 'fulfilled') {
          newCommentIds[result.value.trigger] = result.value.commentId;
        } else {
          // Old comment may have been deleted outside the bot - post fresh.
          console.log(`Could not edit comment for "${trigger}", will post a new one: ${result.reason}`);
          newTriggers.push(trigger);
        }
      }

      // New commands + edit failures needing a fresh comment: sequential
      // with a real delay, since rapid new-comment creation is more likely
      // to get rate-limited.
      newTriggers.push(...triggers.filter((t) => !oldCommentIds[t]));

      for (let i = 0; i < newTriggers.length; i++) {
        const trigger = newTriggers[i];
        const commentText = `## ${trigger}\n\n${responses[trigger]}`;

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 6000));
        }

        const comment = await dictionaryPost.addComment({ text: commentText });
        newCommentIds[trigger] = comment.id;
      }

      // Full replace, not merge, so removed triggers don't linger.
      await redis.del('comment_ids');
      await redis.hSet('comment_ids', newCommentIds);

      // Rebuild the post body with the fresh comment links.
      const body = buildDictionaryPostBody(
        responses,
        categories,
        newCommentIds,
        subreddit.name,
        dictionaryPost.id,
        introText
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
 * Builds the dictionary post body: intro text (if set), "Available
 * commands:" heading, Uncategorized as a plain heading-less list, then
 * each real category (alphabetical, bolded name) with its own list.
 * Commands within every list are sorted alphabetically.
 */
function buildDictionaryPostBody(
  responses: Record<string, string>,
  categories: Record<string, string>,
  commentIds: Record<string, string>,
  subredditName: string,
  dictionaryPostId: string,
  introText: string = ''
): string {
  const UNCATEGORIZED = 'Uncategorized';
  const grouped: Record<string, string[]> = {};

  for (const trigger of Object.keys(responses)) {
    const category = categories[trigger] || UNCATEGORIZED;
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(trigger);
  }

  for (const category of Object.keys(grouped)) {
    grouped[category].sort((a, b) => a.localeCompare(b));
  }

  const parts: string[] = [];

  const trimmedIntro = introText.trim();
  if (trimmedIntro) {
    parts.push(trimmedIntro);
  }

  parts.push('# Available commands:');

  // No heading for Uncategorized - just the list.
  if (grouped[UNCATEGORIZED]) {
    parts.push(buildCommandListMarkdown(grouped[UNCATEGORIZED], commentIds, subredditName, dictionaryPostId));
  }

  const realCategoryNames = Object.keys(grouped)
    .filter((category) => category !== UNCATEGORIZED)
    .sort((a, b) => a.localeCompare(b));

  for (const category of realCategoryNames) {
    const list = buildCommandListMarkdown(grouped[category], commentIds, subredditName, dictionaryPostId);
    parts.push(`**${category}**\n\n${list}`);
  }

  return parts.join('\n\n');
}


// ============================================================================
// AUTO-GENERATED "LIST" COMMANDS
// ============================================================================
/**
 * Two trigger names work with no "bot_responses" entry needed:
 *  - "command-list": bulleted, linked list of every command
 *  - a category's slug (e.g. "diseases" for "Diseases"): same, scoped to
 *    that category
 * Pure fallbacks - a real configured command with the same name wins.
 */
const COMMAND_LIST_TRIGGER = 'command-list';

/** "Tank Setup" -> "tank-setup" */
function slugifyCategory(category: string): string {
  return category
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Plain "- [!trigger](url)" list, alphabetical, linking each trigger to its
 * comment. Skips triggers with no comment posted yet rather than dead-link.
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
    if (!commentId) continue;
    const cleanCommentId = commentId.replace(/^t1_/, '');
    const url = `https://www.reddit.com/r/${subredditName}/comments/${cleanPostId}/comment/${cleanCommentId}/`;
    lines.push(`- [!${trigger}](${url})`);
  }

  return lines.join('\n');
}

/**
 * Builds the reply text for a "list" command over the given triggers.
 * Falls back to a "not generated yet" message if there's no dictionary
 * post/comments to link to.
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
 * Fires on every new comment. Scans for trigger words and replies with the
 * matching response, optionally pinging the OP or parent commenter.
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

    // Extract trigger words after the indicator. Hyphens allowed too, so
    // "!command-list" / "!tank-setup" match in full.
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

    // @op pings the post author, @above pings the parent commenter.
    // Neither present -> defaults to OP.
    const pingOP = commentBody.includes('@op');
    const pingAbove = commentBody.includes('@above');

    const allResponses = await getResponses(context);

    // Category slug -> triggers, for the auto-generated "!<category>" list
    // commands. Rebuilt per comment since categories can change any time.
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

    for (const trigger of triggers) {
      // Real configured command wins if one matches (case-insensitive).
      // Otherwise fall back to the auto-generated list commands.
      const matchedKey = findTriggerKey(allResponses, trigger);
      let response: string | undefined = matchedKey ? allResponses[matchedKey] : undefined;

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