FROM python:3.11-slim

WORKDIR /app

# System deps for nilearn (matplotlib, scipy) and git (to clone tribev2)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install tribev2 from source with plotting support (nilearn brain viewer)
RUN pip install --no-cache-dir \
    "tribev2[plotting] @ git+https://github.com/facebookresearch/tribev2.git"

COPY app.py parcellation.py ./

# HuggingFace Spaces use port 7860
EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
