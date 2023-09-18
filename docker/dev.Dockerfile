FROM 871430721921.dkr.ecr.ap-southeast-2.amazonaws.com/ai-systems/ai_general_cpu:dev-latest

USER root

RUN apt-get update && \
    apt-get install -y zsh python3-pip silversearcher-ag jq

RUN mkdir /opt/poetry && \
    chmod a+w /opt/poetry

ENV POETRY_HOME=/opt/poetry/poetry

RUN mkdir /opt/poetry/poetry && \
    curl -sSL https://install.python-poetry.org | /usr/bin/python3 -

ENV POETRY_VIRTUALENVS_PATH=/opt/poetry

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

ENV CUDA_DEVICE_ORDER=PCI_BUS_ID

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"

ENV PATH=/opt/poetry/poetry/bin:$PATH
ENV BUCKET_URI_PLANCK_LTX=/mnt/data/datasets/planck-ltx-datastore.nearmap.com
ENV PLANCK_LTX_BUCKET_URI=/mnt/data/datasets/planck-ltx-datastore.nearmap.com
ENV HYDRA_FULL_ERROR=1
ENV CONDA_PKGS_DIRS=/opt/storage

RUN mkdir /opt/storage \
&& chmod a+w /opt/storage
