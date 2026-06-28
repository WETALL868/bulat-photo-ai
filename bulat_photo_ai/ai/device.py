"""AI device detection."""
from dataclasses import dataclass
from importlib import import_module, util

@dataclass(frozen=True, slots=True)
class DeviceInfo:
    name: str
    cuda_available: bool


def detect_device(force_cpu: bool = False) -> DeviceInfo:
    """Return CUDA when PyTorch reports an NVIDIA GPU; otherwise CPU."""
    if force_cpu or util.find_spec("torch") is None:
        return DeviceInfo("cpu", False)
    torch = import_module("torch")
    if torch.cuda.is_available():
        return DeviceInfo("cuda", True)
    return DeviceInfo("cpu", False)
