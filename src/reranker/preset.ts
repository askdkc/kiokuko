import { createHash } from 'node:crypto';
import type { ModelArtifactFile, ModelArtifactPreset } from '../embedding/presets/manifest.js';

const ARTIFACT_REVISION = '90213ffc6a8e6f051a6331269a0f5526cdd896f6';
const REPOSITORY = 'onnx-community/bge-reranker-v2-m3-ONNX';

function jsonAsset(path: string, value: unknown): { contents: string; file: ModelArtifactFile } {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.from(contents, 'utf8');
  return {
    contents,
    file: {
      path,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

function specialToken(content: string, lstrip = false): Record<string, unknown> {
  return { content, lstrip, normalized: false, rstrip: false, single_word: false };
}

const tokenizerConfig = jsonAsset('tokenizer_config.json', {
  added_tokens_decoder: {
    '0': { ...specialToken('<s>'), special: true },
    '1': { ...specialToken('<pad>'), special: true },
    '2': { ...specialToken('</s>'), special: true },
    '3': { ...specialToken('<unk>'), special: true },
    '250001': { ...specialToken('<mask>', true), special: true },
  },
  bos_token: '<s>',
  clean_up_tokenization_spaces: true,
  cls_token: '<s>',
  eos_token: '</s>',
  extra_special_tokens: {},
  mask_token: '<mask>',
  model_max_length: 8192,
  pad_token: '<pad>',
  sep_token: '</s>',
  sp_model_kwargs: {},
  tokenizer_class: 'XLMRobertaTokenizer',
  unk_token: '<unk>',
});

const specialTokens = jsonAsset('special_tokens_map.json', {
  bos_token: specialToken('<s>'),
  cls_token: specialToken('<s>'),
  eos_token: specialToken('</s>'),
  mask_token: specialToken('<mask>', true),
  pad_token: specialToken('<pad>'),
  sep_token: specialToken('</s>'),
  unk_token: specialToken('<unk>'),
});

const modelConfig = jsonAsset('config.json', {
  _attn_implementation_autoset: true,
  _name_or_path: 'BAAI/bge-reranker-v2-m3',
  architectures: ['XLMRobertaForSequenceClassification'],
  attention_probs_dropout_prob: 0.1,
  bos_token_id: 0,
  classifier_dropout: null,
  eos_token_id: 2,
  hidden_act: 'gelu',
  hidden_dropout_prob: 0.1,
  hidden_size: 1024,
  id2label: { '0': 'LABEL_0' },
  initializer_range: 0.02,
  intermediate_size: 4096,
  label2id: { LABEL_0: 0 },
  layer_norm_eps: 1e-5,
  max_position_embeddings: 8194,
  model_type: 'xlm-roberta',
  num_attention_heads: 16,
  num_hidden_layers: 24,
  output_past: true,
  pad_token_id: 1,
  position_embedding_type: 'absolute',
  torch_dtype: 'float32',
  transformers_version: '4.49.0',
  type_vocab_size: 1,
  use_cache: true,
  vocab_size: 250002,
});

const bundledFiles = [tokenizerConfig, specialTokens, modelConfig] as const;

export interface LocalRerankerPreset extends ModelArtifactPreset {
  readonly id: 'bge-reranker-v2-m3';
  readonly displayName: 'BGE Reranker v2 m3 (ONNX q8)';
  readonly sourceModel: 'BAAI/bge-reranker-v2-m3';
  readonly dtype: 'q8';
  readonly maximumTokens: 512;
  readonly transformersJsVersion: '4.2.0';
  readonly license: 'Apache-2.0';
}

const files: readonly ModelArtifactFile[] = Object.freeze([
  { path: 'tokenizer.json', size: 17_082_900, sha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3' },
  ...bundledFiles.map((asset) => asset.file),
  { path: 'onnx/model_quantized.onnx', size: 570_727_094, sha256: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d' },
]);

export const LOCAL_RERANKER_PRESET: LocalRerankerPreset = Object.freeze({
  id: 'bge-reranker-v2-m3',
  schemaVersion: 1,
  displayName: 'BGE Reranker v2 m3 (ONNX q8)',
  sourceModel: 'BAAI/bge-reranker-v2-m3',
  artifactRepository: REPOSITORY,
  revision: ARTIFACT_REVISION,
  transformersJsVersion: '4.2.0',
  dtype: 'q8',
  maximumTokens: 512,
  license: 'Apache-2.0',
  maximumBytes: 700 * 1024 * 1024,
  files,
  bundledFiles: Object.freeze(bundledFiles.map((asset) => Object.freeze({
    path: asset.file.path,
    contents: asset.contents,
  }))),
});
