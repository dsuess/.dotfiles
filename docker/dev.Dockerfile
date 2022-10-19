FROM 871430721921.dkr.ecr.ap-southeast-2.amazonaws.com/ai-systems/ai_general_gpu:torch.f9e8e5d

USER root

RUN apt-get update && \
    apt-get install -y zsh python3-pip

RUN /usr/bin/python3 -m pip install poetry==1.2 && \
    /usr/bin/python3 -m pip install -U requests chardet urllib3

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"
