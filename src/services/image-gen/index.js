// 插图生成服务统一出口（Phase C 拆分后保持与原 image-gen.js 对外 API 完全一致）
export {
  isPaidImageProvider, isStrictMechanicalProvider, imageProviderDisplayName,
  generateSeedreamImage, generateWanxImage, generateGrokImage,
  buildGrokWebChatBody, generateGrokWebImage, generateGeminiImage,
  buildOpenAIImageRequestBody, generateOpenAIImage, fetchOpenAIModels
} from './providers.js';
export {
  anchorTextOf, anchorImgOf, mergeAnchorText, resolveAnchorRefImages,
  extractNamedAppearanceAnchor, spliceAnchorIntoPollinationsUrl, ensurePollinationsAnchors
} from './anchors.js';
export {
  OUTFIT_MARKER, DEFAULT_STRICT_OUTFIT_LIBRARY, DEFAULT_STRICT_FORCED_OUTFIT,
  DEFAULT_GROK_FORCED_OUTFIT, DEFAULT_GROK_OUTFIT_LIBRARY,
  parseOutfitLibraryText, outfitLibraryToText, resolveStrictOutfitLibrary, resolveGrokOutfitLibrary
} from './outfit-library.js';
export {
  DEFAULT_COMPOSE_SYSTEM_PROMPT, DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_STRICT_DUO_COMPOSE_SYSTEM_PROMPT, DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT,
  shotWordsOf, prepareIllustrationPrompt, generateIllustrationForReply, generateIllustrationFromPrompt
} from './compose.js';
