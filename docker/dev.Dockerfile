FROM 871430721921.dkr.ecr.ap-southeast-2.amazonaws.com/ai-systems/ai_general_gpu:ailib-latest

USER root

RUN apt-get update && \
    apt-get install -y zsh python3-pip

RUN mkdir /opt/poetry && \
    chmod a+w /opt/poetry

ENV POETRY_HOME=/opt/poetry/poetry

RUN mkdir /opt/poetry/poetry && \
    curl -sSL https://install.python-poetry.org | /usr/bin/python3 -

ENV POETRY_VIRTUALENVS_PATH=/opt/poetry

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"

ENV PATH=/opt/poetry/poetry/bin:$PATH
