"""Conservative, non-atomic copy/verify/remove naming workflow.

Adapted with the owner's explicit MIT authorization from dotknewt/linux-dotfiles,
lib/ollama_name_cleanup.py at 3be5a2d9a36332238f616618f7eaa80e0176ab5f.
Listed IDs are observational evidence, not full-digest proof. External writers
can race every inventory check; no rollback or atomicity is promised.
"""

import re
import subprocess
from collections.abc import Callable


class CleanupError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details if details is not None else {}


def run_ollama(arguments: list[str]) -> str:
    """Run a bounded CLI invocation without shell evaluation."""
    try:
        return subprocess.run(
            ['ollama', *arguments], check=True, capture_output=True,
            text=True, timeout=60,
        ).stdout
    except subprocess.TimeoutExpired as error:
        raise CleanupError('cli_timeout', 'Ollama timed out; command effects may be unknown.') from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise CleanupError('cli_failed', 'Ollama command failed.', {'reason': str(error)}) from error


def _canonical(name):
    return name if ':' in name.rsplit('/', 1)[-1] else name + ':latest'


def _valid_name(name):
    return isinstance(name, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:/-]*', name) is not None


def extract_fields(name):
    text = re.sub(r'[/：:]((?:iq|q)\d[\w.-]*|f16|fp16|bf16|f32)$', '', name, flags=re.I)
    text = text.rsplit('/', 1)[-1].lower()
    families = re.findall(r'(?<![a-z0-9])(?:qwen|gemma|llama|mistral|phi)[-_]?\d+(?:\.\d+)*(?![a-z0-9.])', text)
    sizes = re.findall(r'(?<![a-z0-9])\d+(?:\.\d+)?b(?![a-z0-9])', text)
    family = re.sub(r'[-_]', '', families[0]) if len(set(families)) == 1 else None
    size = sizes[0] if len(set(sizes)) == 1 else None
    for value in families + sizes:
        text = text.replace(value, ' ')
    text = re.sub(r'(?<![a-z0-9])(?:iq|q)\d+(?:_[a-z0-9]+)*(?![a-z0-9])', ' ', text)
    metadata = {'gguf', 'ggml', 'imatrix', 'latest', 'f16', 'fp16', 'bf16', 'f32'}
    descriptors = [token for token in re.findall(r'[a-z0-9]+(?:\.[a-z0-9]+)*', text) if token not in metadata]
    return family, size, list(dict.fromkeys(descriptors))


IDENTITY_EVIDENCE = 'ollama_list_id_not_full_digest_proof'


class Cleanup:
    def __init__(self, runner: Callable[[list[str]], str] = run_ollama) -> None:
        self.runner = runner

    def _run(self, arguments):
        try:
            return self.runner(arguments)
        except CleanupError:
            raise
        except Exception as error:
            code = 'cli_timeout' if isinstance(error, subprocess.TimeoutExpired) else 'cli_failed'
            raise CleanupError(code, 'Ollama command failed.', {'reason': str(error)}) from error

    def _inventory(self):
        output = self._run(['list'])
        lines = output.splitlines() if isinstance(output, str) else []
        if not lines or lines[0].split() != ['NAME', 'ID', 'SIZE', 'MODIFIED']:
            raise CleanupError('invalid_inventory', 'Unexpected Ollama inventory header.')
        models = []
        seen = set()
        for line in lines[1:]:
            if not line.strip():
                continue
            fields = line.split()
            if (len(fields) < 5 or not _valid_name(fields[0])
                    or not re.fullmatch(r'[0-9a-fA-F]{12,64}', fields[1])
                    or not re.fullmatch(r'\d+(?:\.\d+)?', fields[2])
                    or fields[3] not in {'B', 'KB', 'MB', 'GB', 'TB'}):
                raise CleanupError('invalid_inventory', 'Malformed Ollama inventory row.')
            canonical = _canonical(fields[0])
            if canonical in seen:
                raise CleanupError('invalid_inventory', 'Duplicate canonical model name.')
            seen.add(canonical)
            models.append({'name': fields[0], 'canonical_name': canonical, 'observed_id': fields[1].lower()})
        return models

    def list_models(self) -> dict:
        return {'models': self._inventory(), 'identity_evidence': IDENTITY_EVIDENCE}

    def suggest_names(self) -> dict:
        suggestions = []
        for model in self._inventory():
            source = model['name']
            family, size, descriptors = extract_fields(source)
            candidate = f'{family}:{size}' + ''.join(f'-{value}' for value in descriptors) if family and size else None
            suggestions.append({'source': source, 'family': family, 'size': size,
                                'descriptors': descriptors, 'candidate': candidate})
        return {'suggestions': suggestions}

    def rename_model(self, source: str, destination: str, confirmed: bool = False) -> dict:
        if confirmed is not True:
            raise CleanupError('confirmation_required', 'Explicit approval of this exact source and destination is required.')
        component = r'[a-zA-Z0-9][a-zA-Z0-9._-]*'
        if (not _valid_name(source) or not isinstance(destination, str)
                or not re.fullmatch(rf'(?:{component}/)?{component}(?::{component})?', destination)):
            raise CleanupError('invalid_name', 'Invalid source or destination name; option-like names are forbidden.')
        if _canonical(source) == _canonical(destination):
            raise CleanupError('unchanged_name', 'Destination is unchanged.')
        before = self._inventory()
        original = next((model for model in before if model['name'] == source), None)
        if original is None:
            raise CleanupError('source_missing', 'Exact source name is not installed.')
        if any(model['canonical_name'] == _canonical(destination) for model in before):
            raise CleanupError('destination_occupied', 'Destination is already installed.')
        details = {'source': source, 'destination': destination, 'observed_id': original['observed_id'],
                   'identity_evidence': IDENTITY_EVIDENCE, 'stage': 'copy', 'state': 'unknown',
                   'copy_attempted': True, 'remove_attempted': False, 'rollback_attempted': False}
        try:
            self._run(['cp', source, destination])
            details['stage'] = 'verify'
            after = self._inventory()
            details['post_copy_observation'] = after
            identities = {model['canonical_name']: model['observed_id'] for model in after}
            if (identities.get(_canonical(destination)) != original['observed_id']
                    or identities.get(_canonical(source)) != original['observed_id']):
                raise CleanupError('verification_failed', 'Source or destination is missing or its listed ID changed.')
            details['stage'] = 'remove'
            details['remove_attempted'] = True
            self._run(['rm', source])
        except CleanupError as error:
            details['cause'] = {'code': error.code, 'message': error.message, 'details': error.details}
            raise CleanupError('rename_partial_failure',
                               'Rename did not complete reliably; inspect inventory. No rollback was attempted.',
                               details) from error
        return {'status': 'remove_command_succeeded', 'source': source, 'destination': destination,
                'observed_id': original['observed_id'], 'identity_evidence': IDENTITY_EVIDENCE,
                'final_state_verified': False}
