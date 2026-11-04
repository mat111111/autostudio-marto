"""Mini capa de esquemas sobre dataclasses (solo librería estándar).

Sirve para tres cosas con una única definición de campos:
  1. validar y convertir dicts JSON -> dataclasses (`from_dict`),
  2. serializar (`to_dict`),
  3. generar el esquema de parámetros que Gemini necesita para function calling (`json_schema`).
"""
from __future__ import annotations

import dataclasses
import types
import typing
from dataclasses import MISSING, field
from functools import lru_cache
from typing import Any, Literal, Union, get_args, get_origin


class ValidationError(ValueError):
    """Dato inválido. El mensaje está pensado para mostrarse al usuario o al modelo."""


def F(default: Any = MISSING, *, desc: str = "", ge: float | None = None,
      le: float | None = None, factory: Any = None):
    """Declara un campo con metadatos (descripción y rango numérico)."""
    meta = {"desc": desc, "ge": ge, "le": le}
    if factory is not None:
        return field(default_factory=factory, metadata=meta)
    if default is MISSING:
        return field(metadata=meta)
    return field(default=default, metadata=meta)


@lru_cache(maxsize=None)
def _hints(cls: type) -> dict[str, Any]:
    return typing.get_type_hints(cls)


def _is_union(origin: Any) -> bool:
    return origin is Union or origin is getattr(types, "UnionType", object())


def _coerce(value: Any, tp: Any, path: str, strict: bool) -> Any:
    origin = get_origin(tp)
    if tp is Any:
        return value
    if _is_union(origin):
        args = get_args(tp)
        if value is None and type(None) in args:
            return None
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _coerce(value, non_none[0], path, strict)
        raise ValidationError(f"{path}: tipo no soportado")
    if origin is Literal:
        if value not in get_args(tp):
            raise ValidationError(f"{path}: debe ser uno de {list(get_args(tp))}, recibí {value!r}")
        return value
    if origin in (list, typing.List):
        if not isinstance(value, (list, tuple)):
            raise ValidationError(f"{path}: debe ser una lista")
        args = get_args(tp)
        item = args[0] if args else Any
        return [_coerce(v, item, f"{path}[{i}]", strict) for i, v in enumerate(value)]
    if tp is dict or origin is dict:
        if not isinstance(value, dict):
            raise ValidationError(f"{path}: debe ser un objeto")
        return value
    if dataclasses.is_dataclass(tp):
        return from_dict(tp, value, strict=strict, path=path)
    if tp is bool:
        if not isinstance(value, bool):
            raise ValidationError(f"{path}: debe ser true/false")
        return value
    if tp is int:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValidationError(f"{path}: debe ser un entero")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValidationError(f"{path}: debe ser un entero, recibí {value}")
            return int(value)
        return value
    if tp is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValidationError(f"{path}: debe ser un número")
        return float(value)
    if tp is str:
        if not isinstance(value, str):
            raise ValidationError(f"{path}: debe ser texto")
        return value
    raise ValidationError(f"{path}: tipo {tp!r} no soportado")


def from_dict(cls: type, data: Any, *, strict: bool = False, path: str = "") -> Any:
    """Construye `cls` desde un dict validando tipos y rangos.

    strict=True rechaza campos desconocidos (parámetros que vienen de Gemini o de la UI).
    strict=False los ignora (documentos guardados por versiones futuras).
    """
    where = path or cls.__name__
    if not isinstance(data, dict):
        raise ValidationError(f"{where}: se esperaba un objeto")
    hints = _hints(cls)
    kwargs: dict[str, Any] = {}
    for f in dataclasses.fields(cls):
        p = f"{path}.{f.name}" if path else f.name
        if f.name in data:
            v = _coerce(data[f.name], hints[f.name], p, strict)
            if v is not None and isinstance(v, (int, float)) and not isinstance(v, bool):
                ge, le = f.metadata.get("ge"), f.metadata.get("le")
                if ge is not None and v < ge:
                    raise ValidationError(f"{p}: debe ser >= {ge} (recibí {v})")
                if le is not None and v > le:
                    raise ValidationError(f"{p}: debe ser <= {le} (recibí {v})")
            kwargs[f.name] = v
        elif f.default is MISSING and f.default_factory is MISSING:
            raise ValidationError(f"{p}: campo obligatorio")
    if strict:
        unknown = set(data) - {f.name for f in dataclasses.fields(cls)}
        if unknown:
            raise ValidationError(f"{where}: campos desconocidos {sorted(unknown)}")
    obj = cls(**kwargs)
    check = getattr(obj, "validate", None)
    if callable(check):
        check()
    return obj


def to_dict(obj: Any) -> dict[str, Any]:
    return dataclasses.asdict(obj)


def revalidate(obj: Any) -> Any:
    """Ida y vuelta por dict estricto: revalida todo tras mutaciones directas."""
    return from_dict(type(obj), to_dict(obj), strict=True)


# ---------------------------------------------------------------- esquema JSON

def _type_schema(tp: Any) -> dict[str, Any]:
    origin = get_origin(tp)
    if _is_union(origin):
        non_none = [a for a in get_args(tp) if a is not type(None)]
        s = _type_schema(non_none[0])
        s["nullable"] = True
        return s
    if origin is Literal:
        return {"type": "string", "enum": list(get_args(tp))}
    if origin in (list, typing.List):
        args = get_args(tp)
        return {"type": "array", "items": _type_schema(args[0]) if args else {"type": "string"}}
    if dataclasses.is_dataclass(tp):
        return json_schema(tp)
    if tp is bool:
        return {"type": "boolean"}
    if tp is int:
        return {"type": "integer"}
    if tp is float:
        return {"type": "number"}
    return {"type": "string"}


def json_schema(cls: type) -> dict[str, Any]:
    """Esquema estilo OpenAPI (subconjunto que acepta Gemini) para una dataclass."""
    hints = _hints(cls)
    props: dict[str, Any] = {}
    required: list[str] = []
    for f in dataclasses.fields(cls):
        s = _type_schema(hints[f.name])
        if f.metadata.get("desc"):
            s["description"] = f.metadata["desc"]
        if f.metadata.get("ge") is not None:
            s["minimum"] = f.metadata["ge"]
        if f.metadata.get("le") is not None:
            s["maximum"] = f.metadata["le"]
        props[f.name] = s
        if f.default is MISSING and f.default_factory is MISSING:
            required.append(f.name)
    out: dict[str, Any] = {"type": "object", "properties": props}
    if required:
        out["required"] = required
    return out
