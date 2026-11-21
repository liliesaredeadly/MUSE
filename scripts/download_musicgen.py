"""Download only the official checkpoint, with HTTPS verification retained.

No user recording or production instruction is transmitted by this script.
Model weights are CC BY-NC 4.0; intended here for local noncommercial testing.
"""
import argparse
from pathlib import Path
import truststore
truststore.inject_into_ssl()
from huggingface_hub import snapshot_download

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', default=str(Path(__file__).resolve().parents[1] / '.local/musicgen-cache'))
    args = parser.parse_args()
    path = snapshot_download('facebook/musicgen-melody', cache_dir=args.cache_dir,
        allow_patterns=['*.json', '*.model', 'model*.safetensors', 'tokenizer*', 'README.md'], max_workers=2)
    print(f'Official MusicGen Melody checkpoint cached at {path}', flush=True)

if __name__ == '__main__':
    main()
