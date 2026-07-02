import { Devvit, SettingScope, useAsync } from '@devvit/public-api';

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
 * IMPORTANT ENVIRONMENT NOTE (as of this version):
 * This project pins "@devvit/public-api" to 0.12.23 in package.json.
 * @devvit/public-api@0.13.6 (the version that installs via `@latest` right
 * now) is missing/breaks `Devvit.addCustomPostType`, which this bot depends
 * on for the dictionary post. Do NOT bump @devvit/public-api past 0.12.23
 * without testing - it will break the dictionary post again. The `devvit`
 * CLI package itself (the build/upload tool) is separate and fine to keep
 * current.
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
 * Flow:
 *  1. Reuse the existing dictionary post if we have one saved in Redis and
 *     it still exists / hasn't been removed. Otherwise create a new one.
 *  2. Delete old per-command comments (each command gets its own comment
 *     holding the full response text, linked to from the dictionary UI so
 *     long responses aren't crammed into the small post view).
 *  3. Post a fresh comment per command and save its ID in Redis so the
 *     dictionary UI can link out to it.
 *  4. Lock the post so only the bot's comments live there.
 *
 * Note: this reuses the same post/URL across updates rather than creating a
 * new one each time, so links to the dictionary post stay stable. If you
 * want it pinned to the top of the sub, pin it manually from Reddit's post
 * menu - that survives content updates fine, since this only edits comments,
 * not the post itself.
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
        // Try to reuse the existing post
        try {
          dictionaryPost = await reddit.getPostById(existingPostId);

          // A mod/admin removed our post - start fresh instead of
          // continuing to reference a dead post.
          if (dictionaryPost.removed) {
            console.log('Dictionary post was removed, creating new one');
            needsNewPost = true;
          } else {
            // Unlock post for editing
            await dictionaryPost.unlock();

            // Delete old comments (with delays to avoid rate limiting)
            const oldCommentIds = await redis.hGetAll('comment_ids');
            const oldIds = Object.values(oldCommentIds);
            for (let i = 0; i < oldIds.length; i++) {
              try {
                if (i > 0) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
                const comment = await reddit.getCommentById(oldIds[i]);
                await comment.delete();
              } catch (e) {
                // Non-fatal: comment may already be gone. Log and continue.
                console.log(`Could not delete comment ${oldIds[i]}: ${e}`);
              }
            }

            // Wait before posting new comments
            if (oldIds.length > 0) {
              await new Promise(resolve => setTimeout(resolve, 3000));
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
        // Create new dictionary post. This `preview` is what shows briefly
        // before the custom post's `render()` (below) takes over.
        dictionaryPost = await reddit.submitPost({
          title: '📖 Bot Command Dictionary',
          subredditName: subreddit.name,
          preview: (
            <vstack padding="medium" gap="medium">
              <text size="xlarge" weight="bold">📖 Command Dictionary</text>
              <text>Loading commands...</text>
            </vstack>
          ),
        });

        await redis.set('dictionary_post_id', dictionaryPost.id);
        await redis.del('comment_ids');
      }

      // Post one comment per command holding its full response text
      const newCommentIds: Record<string, string> = {};

      for (let i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        const response = responses[trigger];
        const commentText = `## ${trigger}\n\n${response}`;

        // 6s delay between comments to avoid Reddit rate limits when there
        // are many commands - this loop can take a while for large lists.
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 6000));
        }

        const comment = await dictionaryPost.addComment({
          text: commentText,
        });

        newCommentIds[trigger] = comment.id;
      }

      // Save comment IDs and lock post
      await redis.hSet('comment_ids', newCommentIds);
      await dictionaryPost.lock();

      ui.showToast(`Dictionary updated with ${triggers.length} commands`);
    } catch (error) {
      console.error('Error updating dictionary:', error);
      ui.showToast('Error updating dictionary. Check logs.');
    }
  },
});

// ============================================================================
// COMMAND DICTIONARY - interactive custom post
// ============================================================================
/**
 * Renders the browsable command list inside the dictionary post created
 * above. Devvit re-runs `render()` whenever the post needs to draw itself.
 *
 * DATA LOADING - THIS IS THE PIECE THAT WAS FIXED:
 * Data (the command list + comment ID map) now loads via `useAsync`, which
 * runs the fetch once when the post renders and gives back a `loading` flag
 * automatically.
 *
 * Why the previous approach got stuck on "Loading commands...": it kicked
 * off the data-fetching promise directly inside the render function body
 * (`if (!loaded) { getResponses(...).then(...) }`), not through a Devvit
 * hook. Devvit only knows to re-render a custom post in response to its own
 * hooks (useState, useAsync, useInterval, etc.) - state changes coming from
 * a raw, unmanaged promise chain aren't guaranteed to trigger that re-render
 * the way a hook's state update does. So `setLoaded(true)` could fire
 * without ever prompting Devvit to actually redraw the post, leaving it
 * stuck showing the loading state forever even after the data had finished
 * loading behind the scenes. `useAsync` avoids this because Devvit manages
 * the whole load-and-re-render cycle itself.
 *
 * IMPORTANT API NOTE FOR THIS PACKAGE VERSION (@devvit/public-api@0.12.23):
 * Unlike `useState` and `useInterval`, `useAsync` is NOT a property on the
 * `context` object in this version - it must be imported directly from
 * '@devvit/public-api' (see the import at the top of this file) and called
 * as a standalone function. Calling `context.useAsync(...)` here will throw
 * "useAsync is not a function" at runtime, even though TypeScript may not
 * always flag it depending on how `context` is typed.
 */
// How many commands to show per page within a single category. Devvit's
// fixed-height canvas (512px for 'tall') has no exact per-element pixel
// values exposed to app code, so this number is a conservative starting
// estimate, not a precise calculation - if rows are getting clipped at the
// bottom of the screen with real content, lower this; if there's a lot of
// empty space, raise it.
const COMMANDS_PER_PAGE = 4;

Devvit.addCustomPostType({
  name: 'Command Dictionary',
  height: 'tall',
  render: (context) => {
    const { redis } = context;

    // Devvit custom posts have a fixed canvas (max height is 'tall' - there
    // is no scrolling and no bigger size available). A flat list of every
    // command across every category can easily run off the bottom of that
    // fixed area with nothing to scroll it into view. To keep this usable
    // regardless of how many commands get added, the post shows a compact
    // category picker first, and only expands into a given category's full
    // command list when tapped - so each individual screen stays short.
    // Within a category, commands are further split into pages (see
    // COMMANDS_PER_PAGE above) in case a single category itself grows
    // large enough to overflow the fixed canvas.
    const [selectedCategory, setSelectedCategory] = context.useState<string | null>(null);
    const [page, setPage] = context.useState<number>(0);

    // Loads the command list (from settings) and the comment ID map (from
    // Redis) together, once, when this post renders. `loading` and `error`
    // are provided automatically - no manual state juggling needed.
    const { data, loading, error } = useAsync(async () => {
      const [responses, commentIds, categories, subreddit] = await Promise.all([
        getResponses(context),
        redis.hGetAll('comment_ids'),
        getCategories(context),
        context.reddit.getCurrentSubreddit(),
      ]);
      return {
        responses: responses || {},
        commentIds: commentIds || {},
        categories: categories || {},
        subredditName: subreddit.name,
      };
    });

    if (loading) {
      return (
        <vstack padding="medium" alignment="center middle" grow>
          <text size="large">Loading commands...</text>
        </vstack>
      );
    }

    if (error || !data) {
      // Surfaces real load failures instead of looking identical to the
      // old "stuck loading" bug - makes future debugging much faster.
      console.error('[Dictionary] Error loading data:', error);
      return (
        <vstack padding="medium" gap="medium" alignment="center middle" grow>
          <text size="large" weight="bold">Couldn't load commands</text>
          <text size="small" color="gray">Check the logs, or try refreshing.</text>
        </vstack>
      );
    }

    const triggers = Object.keys(data.responses).sort();

    if (triggers.length === 0) {
      return (
        <vstack padding="medium" gap="medium" alignment="center middle" grow>
          <text size="xlarge" weight="bold">📖 Command Dictionary</text>
          <text color="gray">No commands configured yet</text>
          <text size="small" color="gray">Moderators: Add commands in app settings</text>
        </vstack>
      );
    }

    // Group triggers by category for easier skimming. Anything without a
    // category assigned in settings falls into "Uncategorized" rather than
    // being dropped or erroring out.
    const UNCATEGORIZED = 'Uncategorized';
    const groupedTriggers: Record<string, string[]> = {};
    for (const trigger of triggers) {
      const category = data.categories[trigger] || UNCATEGORIZED;
      if (!groupedTriggers[category]) groupedTriggers[category] = [];
      groupedTriggers[category].push(trigger);
    }

    // Alphabetical by category name, but "Uncategorized" always sorts last
    // so miscellaneous commands don't interrupt the meaningful categories.
    const categoryNames = Object.keys(groupedTriggers).sort((a, b) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });

    // SCREEN 1: category picker (default view). Shows just category names
    // and counts - compact enough to always fit, no matter how many
    // commands exist underneath.
    if (!selectedCategory) {
      return (
        <vstack padding="medium" gap="small" grow>
          <vstack gap="small" padding="medium" backgroundColor="neutral-background-weak" cornerRadius="small">
            <text size="xxlarge" weight="bold">📖 Command Dictionary</text>
            <text size="medium" color="gray">{triggers.length} commands available</text>
            <text size="small" color="gray" wrap>
              Tap a category to view its commands
            </text>
          </vstack>

          <vstack gap="small" padding="small">
            {categoryNames.map((category) => (
              <hstack
                key={category}
                gap="small"
                padding="medium"
                backgroundColor="neutral-background"
                cornerRadius="small"
                border="thin"
                borderColor="neutral-border"
                alignment="middle"
                onPress={() => {
                  setSelectedCategory(category);
                  setPage(0); // reset to page 1 whenever a new category is opened
                }}
              >
                <text size="large" weight="bold" color="primary" grow>
                  {category}
                </text>
                <text size="medium" color="gray">
                  {groupedTriggers[category].length} →
                </text>
              </hstack>
            ))}
          </vstack>

          <vstack padding="medium" backgroundColor="neutral-background-weak" cornerRadius="small">
            <text size="small" color="gray" wrap>
              Use these commands by commenting on any post. Add @OP to ping the original poster or @above to ping the person you're replying to.
            </text>
          </vstack>
        </vstack>
      );
    }

    // SCREEN 2: a single category's commands, with a back button to
    // return to the picker. `selectedCategory` could in theory point to a
    // category that no longer exists (e.g. settings changed while this was
    // open) - fall back to an empty list rather than crashing.
    const triggersInCategory = groupedTriggers[selectedCategory] ?? [];

    // Paginate within the category - a single category (e.g. a big
    // "Diseases" list) can itself outgrow the fixed canvas just like the
    // full flat list used to. `page` is clamped so it can't land past the
    // last valid page if the command list shrinks while paged in.
    const totalPages = Math.max(1, Math.ceil(triggersInCategory.length / COMMANDS_PER_PAGE));
    const currentPage = Math.min(page, totalPages - 1);
    const pageStart = currentPage * COMMANDS_PER_PAGE;
    const pagedTriggers = triggersInCategory.slice(pageStart, pageStart + COMMANDS_PER_PAGE);

    return (
      <vstack padding="medium" gap="small" grow>
        <hstack gap="small" alignment="middle">
          <button
            onPress={() => setSelectedCategory(null)}
            appearance="secondary"
            size="small"
          >
            ← All Categories
          </button>
        </hstack>

        <vstack gap="small" padding="medium" backgroundColor="neutral-background-weak" cornerRadius="small">
          <text size="xxlarge" weight="bold">{selectedCategory}</text>
          <text size="medium" color="gray">{triggersInCategory.length} commands</text>
        </vstack>

        <vstack gap="small" padding="small" grow>
          {pagedTriggers.map((trigger) => {
            const commentId = data.commentIds[trigger];
            const hasComment = !!commentId;

            return (
              <hstack
                key={trigger}
                gap="small"
                padding="medium"
                backgroundColor="neutral-background"
                cornerRadius="small"
                border="thin"
                borderColor="neutral-border"
                alignment="middle"
              >
                <vstack gap="small" grow>
                  <text size="large" weight="bold" color="primary">!{trigger}</text>
                  {!hasComment && (
                    <text size="small" color="orange">Full text not yet posted</text>
                  )}
                </vstack>
                {hasComment && (
                  <button
                    onPress={() => {
                      // Devvit IDs come back with their type prefix attached
                      // (posts: "t3_...", comments: "t1_..."). Those prefixes
                      // must be stripped for a working reddit.com URL - a
                      // link built from the raw prefixed IDs 404s/misroutes.
                      const cleanPostId = context.postId?.replace(/^t3_/, '');
                      const cleanCommentId = commentId.replace(/^t1_/, '');
                      context.ui.navigateTo(
                        `https://www.reddit.com/r/${data.subredditName}/comments/${cleanPostId}/comment/${cleanCommentId}/`
                      );
                    }}
                    appearance="secondary"
                    size="small"
                  >
                    View Full Text →
                  </button>
                )}
              </hstack>
            );
          })}
        </vstack>

        {totalPages > 1 && (
          <hstack gap="small" alignment="middle center">
            <button
              onPress={() => setPage(Math.max(0, currentPage - 1))}
              appearance="secondary"
              size="small"
              disabled={currentPage === 0}
            >
              ← Prev
            </button>
            <text size="small" color="gray">
              Page {currentPage + 1} of {totalPages}
            </text>
            <button
              onPress={() => setPage(Math.min(totalPages - 1, currentPage + 1))}
              appearance="secondary"
              size="small"
              disabled={currentPage >= totalPages - 1}
            >
              Next →
            </button>
          </hstack>
        )}
      </vstack>
    );
  },
});

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