/**
 * Prompt Sanitizer (QA-1)
 *
 * Zero-cost safety net that catches raw proper nouns in storyboard
 * descriptions before they reach image generation. The Director AI is
 * instructed to use visual translations, but this validates it actually did.
 *
 * Cost: $0.00 — pure string matching, no AI calls.
 */

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Description fields to scan on each storyboard sequence.
 * Each entry: [fieldName, skipIfMatchesSpeaker]
 *
 * skipIfMatchesSpeaker: If true, don't replace a proper noun in this field
 * when the noun matches the sequence's speaker name. This prevents replacing
 * "Bixie" in "Bixie — calm half-smile, knowing eyes..." which is the intended
 * subject of the portrait, not a leaked proper noun.
 */
const DESCRIPTION_FIELDS = [
  ['backgroundDescription', false],
  ['portraitDescription', true],    // Skip speaker's own name
  ['actionDescription', false],
  ['visualNotes', false],
];

/**
 * Scan storyboard description fields for raw proper nouns and replace
 * them with visual translations from the session summary.
 *
 * Mutates the storyboard sequences in-place (they're direct references).
 *
 * @param {object} storyboard - The storyboard object (must have storyboard.plan.sequences)
 * @param {object} properNounTranslations - Map of { "NounName": "visual description..." }
 * @returns {object} Report: { substitutions: [{order, field, noun, original, replaced}], totalReplacements: number }
 */
export function sanitizeStoryboardDescriptions(storyboard, properNounTranslations) {
  const report = {
    substitutions: [],
    totalReplacements: 0,
  };

  if (!storyboard?.plan?.sequences || !properNounTranslations) {
    return report;
  }

  const nouns = Object.entries(properNounTranslations);
  if (nouns.length === 0) return report;

  for (const seq of storyboard.plan.sequences) {
    const speaker = seq.speaker || '';

    for (const [fieldName, skipIfMatchesSpeaker] of DESCRIPTION_FIELDS) {
      const value = seq[fieldName];
      if (!value || typeof value !== 'string') continue;

      let updated = value;

      for (const [noun, visualTranslation] of nouns) {
        // Skip replacing the speaker's own name in portrait descriptions
        // e.g. don't replace "Bixie" in portraitDescription when speaker is "Bixie"
        if (skipIfMatchesSpeaker && speaker && nounMatchesSpeaker(noun, speaker)) {
          continue;
        }

        // Word-boundary regex: prevents partial matches (e.g. "Bit" inside "Bixie")
        // Case-insensitive to catch variations
        const pattern = new RegExp('\\b' + escapeRegex(noun) + '\\b', 'gi');

        if (pattern.test(updated)) {
          const original = updated;

          // Smart replacement: avoid article collisions like "the an infinite expanse"
          // If the translation starts with an article and there's already one before the noun,
          // strip the translation's leading article.
          const cleanTranslation = stripLeadingArticle(visualTranslation);

          // Also handle: "the Astral Sea" → use cleanTranslation (no double article)
          // But "inside Astral Sea" → use original translation (no preceding article)
          updated = updated.replace(pattern, (match, offset, str) => {
            // Check if there's an article immediately before this match
            const before = str.substring(Math.max(0, offset - 4), offset).toLowerCase();
            const hasArticleBefore = /\b(the|an?)\s$/i.test(before);
            return hasArticleBefore ? cleanTranslation : visualTranslation;
          });

          report.substitutions.push({
            order: seq.order,
            field: fieldName,
            noun,
            original: original.substring(0, 100),
            replaced: updated.substring(0, 100),
          });
          report.totalReplacements++;
        }
      }

      // Write back if changed
      if (updated !== value) {
        seq[fieldName] = updated;
      }
    }
  }

  return report;
}

/**
 * Strip a leading article ("a ", "an ", "the ") from a translation string.
 * Used to avoid article collisions like "the an infinite expanse".
 *
 * @param {string} text
 * @returns {string}
 */
function stripLeadingArticle(text) {
  return text.replace(/^(the|an?)\s+/i, '');
}

/**
 * Check if a proper noun matches a sequence's speaker name.
 * Handles cases like:
 *   - Exact match: noun "Bixie", speaker "Bixie"
 *   - Name within speaker: noun "Bixie", speaker "Kristin (Bixie)"
 *   - Case-insensitive match
 *
 * @param {string} noun - The proper noun key
 * @param {string} speaker - The sequence's speaker field
 * @returns {boolean}
 */
function nounMatchesSpeaker(noun, speaker) {
  const nounLower = noun.toLowerCase();
  const speakerLower = speaker.toLowerCase();

  // Direct match
  if (nounLower === speakerLower) return true;

  // Noun appears as a word within the speaker string
  // e.g. "Bixie" in "Kristin (Bixie)"
  const pattern = new RegExp('\\b' + escapeRegex(nounLower) + '\\b', 'i');
  return pattern.test(speakerLower);
}
