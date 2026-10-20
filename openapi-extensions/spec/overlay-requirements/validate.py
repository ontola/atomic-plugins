"""Overlay Requirements 0.1.0-draft: x-requires and x-conflicts on an Overlay's Info Object.

`validate(overlay, url=None)` raises ValueError listing every violation of the
document rules of §7. `check_composition(overlays)` takes {resolved URL:
overlay document} and returns the problems a composer must not accept (§7):
unmet groups and conflicts, each naming the overlays involved.
"""
import json
import sys
from urllib.parse import urljoin


def _reference(value):
    """Whether a value is a string usable as a URI reference (no whitespace, no fragment-only)."""
    return isinstance(value, str) and value != "" and value == value.strip() and not any(c.isspace() for c in value) \
        and not value.startswith("#")


def resolve(reference, base):
    """The URL a reference names, resolved against the overlay's own URL (RFC 3986 §5)."""
    return urljoin(base, reference) if base else reference


def requirements(overlay, url=None):
    """(groups, conflicts) of resolved references; empty when the overlay declares none."""
    info = overlay.get("info") if isinstance(overlay, dict) else None
    info = info if isinstance(info, dict) else {}
    groups = [[resolve(r, url) for r in group["anyOf"]] for group in info.get("x-requires") or []]
    conflicts = [resolve(r, url) for r in info.get("x-conflicts") or []]
    return groups, conflicts


def validate(overlay, url=None):
    errors = []
    info = overlay.get("info") if isinstance(overlay, dict) else None
    if not isinstance(info, dict):
        raise ValueError("info: expected an object")
    requires, conflicts = info.get("x-requires"), info.get("x-conflicts")
    named = []
    if requires is not None:
        if not isinstance(requires, list) or not requires:
            errors.append("info.x-requires: expected a nonempty array of groups (rule 1)")
        else:
            for index, group in enumerate(requires):
                if not isinstance(group, dict) or set(group) != {"anyOf"} or not isinstance(group["anyOf"], list) \
                        or not group["anyOf"] or not all(_reference(r) for r in group["anyOf"]):
                    errors.append(f"info.x-requires[{index}]: expected an object with a nonempty anyOf array of URI references (rule 1)")
                    continue
                resolved = [resolve(r, url) for r in group["anyOf"]]
                if len(set(resolved)) != len(resolved):
                    errors.append(f"info.x-requires[{index}]: an overlay is named twice (rule 3)")
                named.extend(resolved)
    if conflicts is not None:
        if not isinstance(conflicts, list) or not conflicts or not all(_reference(r) for r in conflicts):
            errors.append("info.x-conflicts: expected a nonempty array of URI references (rule 2)")
            conflicts = None
        else:
            resolved = [resolve(r, url) for r in conflicts]
            if len(set(resolved)) != len(resolved):
                errors.append("info.x-conflicts: an overlay is named twice (rule 3)")
            both = sorted(set(resolved) & set(named))
            if both:
                errors.append(f"info: {both} both required and in conflict (rule 3)")
            named.extend(resolved)
    if url and resolve(url, url) in named:
        errors.append("info: the overlay names itself (rule 3)")
    if errors:
        raise ValueError("\n".join(errors))


def check_composition(overlays):
    """Problems of a composition {resolved URL: overlay}: unmet groups and conflicts (§7)."""
    problems = []
    present = set(overlays)
    for url in sorted(overlays):
        groups, conflicts = requirements(overlays[url], url)
        for group in groups:
            if not present & set(group):
                problems.append(f"{url}: requires one of {group}, none applied")
        for other in conflicts:
            if other in present:
                problems.append(f"{url}: conflicts with {other}, which is applied")
    return problems


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))  # relative references are compared as written
        print(f"{name}: overlay requirements valid")
